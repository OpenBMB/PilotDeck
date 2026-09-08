// This process anchors one command's process group. Its lifetime and registration
// are independent of the Gateway that requested the command.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { listProcesses, getProcessIdentity, WINDOWS_STARTUP_TIMEOUT_MS } = require('./processIdentity.cjs');
const { writeRecord, isClosing } = require('./processScope.cjs');
const file = process.argv[2];
let record = JSON.parse(fs.readFileSync(file, 'utf8'));
const directory = path.dirname(file);
const closing = () => isClosing(directory, path.basename(file, '.json'));
if (closing()) { writeRecord(file, { state: 'done', parent: record.parent }); process.exit(0); }
let identity;
let worker;
let exited = false;
let code = 1;
process.on('SIGTERM', () => {}); // Keep the POSIX group anchor until forced stop.
process.on('SIGINT', () => {});
function complete(value, signal, startupError) {
  if (exited) return;
  exited = true; code = value ?? 1;
  fs.writeSync(record.completionFd, JSON.stringify({ code: value, signal, ...(startupError ? { startupError } : {}) }) + '\n');
  fs.closeSync(record.completionFd);
}
async function launch() {
  const deadline = Date.now() + WINDOWS_STARTUP_TIMEOUT_MS;
  identity = getProcessIdentity(process.pid);
  if (!identity?.birth) throw new Error('Cannot establish guardian identity');
  record = { ...record, state: 'active', identity, members: [identity] };
  writeRecord(file, record);
  if (process.platform === 'win32') {
    const ready = `${file}.ready`, stopped = `${file}.stopped`, stop = `${file}.stop`;
    const holder = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'processJob.ps1'), String(process.pid), ready, stopped, stop, identity.birth], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let failed = false;
    let diagnostic = '';
    holder.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    holder.on('error', error => { failed = true; diagnostic = error.message; });
    holder.on('exit', () => { if (!fs.existsSync(ready)) failed = true; });
    record.job = { ready, stopped, stop, holder: holder.pid };
    writeRecord(file, record);
    record.job.holderIdentity = getProcessIdentity(holder.pid);
    if (!record.job.holderIdentity) throw new Error('Windows Job supervisor identity unavailable');
    writeRecord(file, record);
    while (!fs.existsSync(ready)) {
      if (failed || Date.now() >= deadline) throw new Error(`Windows process containment could not be established: ${diagnostic.trim() || 'startup deadline exceeded'}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (closing()) return;
  const stdio = Array.from({ length: record.descriptors || 3 }, (_, index) => index);
  if (record.ipc) stdio[record.ipcIndex >= 0 ? record.ipcIndex : 3] = 'ipc';
  worker = cp.spawn(record.command, record.args, {
    stdio, env: process.env, detached: false, windowsHide: true, argv0: record.argv0,
    serialization: record.serialization, shell: record.shell, windowsVerbatimArguments: record.windowsVerbatimArguments,
  });
  if (record.ipc) {
    process.on('message', message => { if (worker.connected) worker.send(message, () => {}); });
    worker.on('message', message => { if (process.connected) process.send(message, () => {}); });
    process.on('disconnect', () => { if (worker.connected) worker.disconnect(); });
  }
  worker.on('error', error => { process.stderr.write(`PilotDeck command failed: ${error.message}\n`); complete(1, null); });
  worker.on('exit', (value, signal) => complete(value, signal));
}
launch().catch(error => {
  const message = `Managed process startup failed: ${error.message}`;
  process.stderr.write(`${message}\n`);
  // No user command has run. Report bootstrap failure before tests/owners wait
  // indefinitely for application IPC. An incomplete Job still requires cleanup.
  if (!record.job) {
    writeRecord(file, { state: 'done', parent: record.parent });
    complete(1, null, message);
    process.exit(1);
  }
  record.uncertain = true;
  writeRecord(file, record);
  complete(1, null, message);
});
const timer = setInterval(() => {
  try {
    if (!exited || closing()) return;
    if (process.platform !== 'win32') {
      const rows = listProcesses();
      const remaining = rows.filter(row => row.pid !== process.pid && !(row.parent === process.pid && row.pid !== worker.pid)
        && !row.zombie && row.group === process.pid);
      if (remaining.length) return;
    }
    // On Windows the external Job holder certifies descendant termination after
    // this guardian exits; a plain PID disappearing is never that certificate.
    writeRecord(file, process.platform === 'win32' ? { ...record, state: 'exiting' } : { state: 'done', parent: record.parent });
    clearInterval(timer);
    process.exit(code);
  } catch { record.uncertain = true; writeRecord(file, record); }
}, 200);
