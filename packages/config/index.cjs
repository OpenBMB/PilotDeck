const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const YAML = require('yaml');

const warned = new Set();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function resolveConfigHome(env = process.env) {
  const home = env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck');
  return path.resolve(home === '~' ? os.homedir() : home.startsWith('~/') ? path.join(os.homedir(), home.slice(2)) : home);
}

function report(diagnostics, options, code, file, key, message) {
  const issue = { code, path: file, field: key || '', message, recoverable: true };
  diagnostics.push(issue);
  if (options.onDiagnostic) options.onDiagnostic(issue);
  else {
    const id = `${code}:${file}:${key}`;
    if (!warned.has(id)) {
      warned.add(id);
      console.warn(`[${code}] ${file}${key ? ` (${key})` : ''}: ${message}`);
    }
  }
}

function recoverValues(value, defaults, issue, prefix = '') {
  if (record(defaults)) {
    if (!record(value)) {
      if (value !== undefined) issue(prefix, 'Expected an object; using defaults.');
      value = {};
    }
    const output = { ...value };
    for (const [key, fallback] of Object.entries(defaults)) {
      output[key] = recoverValues(value[key], fallback, issue, prefix ? `${prefix}.${key}` : key);
    }
    return output;
  }
  const valid = value !== undefined && (Array.isArray(defaults) ? Array.isArray(value)
    : defaults === null ? value === null || record(value)
      : typeof value === typeof defaults && (typeof value !== 'number' || Number.isFinite(value)));
  if (valid) return clone(value);
  if (value !== undefined) issue(prefix, 'Invalid type; using the default value.');
  return clone(defaults);
}

function backup(file, raw, target) {
  const directory = path.join(path.dirname(target), 'backups', 'configuration');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const destination = path.join(directory, `${path.basename(file)}.${hash}.bak`);
  try { fs.writeFileSync(destination, raw, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

function withLock(file, operation) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`, token = randomUUID(), deadline = Date.now() + 5_000;
  let handle;
  while (handle === undefined) {
    try { handle = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (!alive && Date.now() - fs.statSync(lock).mtimeMs > 1_000) { fs.unlinkSync(lock); continue; }
      } catch { /* A lock can still be receiving its ownership record. */ }
      if (Date.now() >= deadline) throw Object.assign(new Error('Configuration write is busy; retry shortly.'), { code: 'PD_CONFIG_BUSY' });
      pause(10);
    }
  }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token }));
    return operation();
  } finally {
    fs.closeSync(handle);
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock); } catch { /* Owner already cleaned up. */ }
  }
}

function writeUnlocked(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const content = '# PilotDeck user configuration\n' + YAML.stringify(value, { indent: 2, lineWidth: 100, aliasDuplicateObjects: false });
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, content, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return value;
}

function writeConfiguration(file, value) {
  return withLock(path.resolve(file), () => writeUnlocked(path.resolve(file), value));
}

function readConfiguration(file, options = {}) {
  file = path.resolve(file);
  const defaults = options.defaults ?? {}, diagnostics = [];
  const source = fs.existsSync(file) ? file : (options.legacyPaths || []).find(candidate => fs.existsSync(candidate));
  let raw = '', value = {}, writable = true;
  if (source) {
    try {
      raw = fs.readFileSync(source, 'utf8');
      if (/\.json$/i.test(source)) value = JSON.parse(raw);
      else {
        const document = YAML.parseDocument(raw, { uniqueKeys: true });
        for (const error of document.errors) report(diagnostics, options, 'PD_CONFIG_SYNTAX', source, '', `YAML ${error.code}; recovering readable fields.`);
        value = document.toJS({ maxAliasCount: 100 }) ?? {};
      }
    } catch (error) {
      if (error.code && !['ENOENT'].includes(error.code) && !error.name?.includes('YAML') && !(error instanceof SyntaxError)) writable = false;
      report(diagnostics, options, 'PD_CONFIG_READ', source, '', 'Could not read configuration; using available defaults.');
    }
  }
  const originalValue = value;
  if (record(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > 1) {
    writable = false;
    report(diagnostics, options, 'PD_CONFIG_VERSION', file, 'schemaVersion', 'Configuration was written by a newer version; preserving its original bytes.');
  }
  const issue = (key, message) => report(diagnostics, options, 'PD_CONFIG_FIELD', file, key, message);
  value = recoverValues(value, defaults, issue);
  if (options.normalize) {
    try { value = options.normalize(value, issue); }
    catch { issue('', 'Configuration normalization failed; using defaults.'); value = clone(defaults); }
  }
  const migrated = Boolean(source && source !== file);
  const changed = JSON.stringify(originalValue) !== JSON.stringify(value);
  if (writable && options.repair !== false && (migrated || diagnostics.length || changed || (!source && options.create !== false))) {
    try {
      withLock(file, () => {
        // Another process may already have migrated this file. Never overwrite it.
        if (migrated && fs.existsSync(file)) return;
        if (source) backup(source, raw, file);
        if (source === file && fs.readFileSync(file, 'utf8') !== raw) return;
        writeUnlocked(file, value);
      });
    } catch { report(diagnostics, options, 'PD_CONFIG_WRITE', file, '', 'Could not persist recovered configuration; continuing with in-memory defaults.'); }
  }
  return { value, diagnostics, migrated, source: source || null, path: file };
}

function updateConfiguration(file, update, options = {}) {
  file = path.resolve(file);
  return withLock(file, () => {
    const loaded = readConfiguration(file, { ...options, repair: false, create: false });
    if (loaded.diagnostics.some(issue => issue.code === 'PD_CONFIG_VERSION')) {
      throw Object.assign(new Error('Configuration belongs to a newer version; refusing to overwrite it.'), { code: 'PD_CONFIG_VERSION' });
    }
    const current = loaded.value;
    return writeUnlocked(file, update(current));
  });
}

module.exports = { resolveConfigHome, readConfiguration, writeConfiguration, updateConfiguration, recoverValues };
