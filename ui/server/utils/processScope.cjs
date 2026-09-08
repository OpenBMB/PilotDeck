// Explicit service/build supervision only. Business subprocess APIs and their
// environment are left untouched; arbitrary detached business tasks are not owned.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const cp = require('node:child_process');
const { WINDOWS_STARTUP_TIMEOUT_MS } = require('./processIdentity.cjs');
const KEY = Symbol.for('pilotdeck.processScope');
function writeRecord(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function isClosing(directory, entry) {
  if (fs.existsSync(path.join(directory, 'closing'))) return true;
  const visited = new Set();
  while (entry && !visited.has(entry)) {
    visited.add(entry);
    if (fs.existsSync(path.join(directory, `${entry}.closing`))) return true;
    const record = JSON.parse(fs.readFileSync(path.join(directory, `${entry}.json`), 'utf8'));
    entry = record.parent;
  }
  return false;
}
function attach(child, scope) {
  child[KEY] = scope;
  // Completion of the command is independent of the group's guardian lifetime.
  let completed = false;
  let buffered = '';
  const report = (result) => {
    if (completed) return;
    completed = true;
    scope.completion = result;
    child.emit('managed-exit', result.code, result.signal, result.startupError);
  };
  child.stdio[scope.completionFd].setEncoding('utf8').on('data', chunk => {
    buffered += chunk;
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    try { report(JSON.parse(buffered.slice(0, newline))); }
    catch { report({ code: 1, signal: null }); }
  });
  child.once('exit', (code, signal) => { if (!completed) report({ code: code || 1, signal }); });
}
function prepare(scope, spec) {
  if (isClosing(scope.directory, scope.entry)) throw new Error('PilotDeck runtime is stopping');
  const entry = randomUUID();
  const file = path.join(scope.directory, `${entry}.json`);
  writeRecord(file, { state: 'pending', parent: scope.entry || null, ...spec });
  // A stop racing registration sees either this pending record or the closing
  // marker. It cannot miss a command that has already started executing.
  if (isClosing(scope.directory, scope.entry)) {
    writeRecord(file, { state: 'done', parent: scope.entry || null });
    throw new Error('PilotDeck runtime is stopping');
  }
  return { directory: scope.directory, entry, file };
}
function spawnManaged(command, args, options, node = process.execPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-process-scope-'));
  fs.chmodSync(directory, 0o700);
  const scope = prepare({ directory }, { command, args, ipc: Array.isArray(options.stdio) && options.stdio.includes('ipc'), ipcIndex: Array.isArray(options.stdio) ? options.stdio.indexOf('ipc') : -1, serialization: options.serialization, descriptors: Array.isArray(options.stdio) ? options.stdio.length : 3 });
  const env = { ...(options.env || process.env) };
  // No preload or environment propagation into business commands.
  const stdio = Array.isArray(options.stdio) ? [...options.stdio] : ['ignore', 'pipe', 'pipe'];
  scope.completionFd = stdio.length;
  if (process.platform === 'win32') scope.startupDeadline = Date.now() + WINDOWS_STARTUP_TIMEOUT_MS;
  stdio.push('pipe');
  // shell belongs to the real command, not the Node guardian executable.
  const record = JSON.parse(fs.readFileSync(scope.file, 'utf8'));
  writeRecord(scope.file, { ...record, shell: options.shell, completionFd: scope.completionFd });
  const child = cp.spawn(node, [path.join(__dirname, 'processGuardian.cjs'), scope.file], {
    ...options, stdio, shell: false, detached: process.platform !== 'win32', env,
  });
  attach(child, scope);
  child.once('error', () => { if (!child.pid) writeRecord(scope.file, { state: 'done', parent: null }); });
  return child;
}
module.exports = { KEY, writeRecord, spawnManaged, isClosing };
