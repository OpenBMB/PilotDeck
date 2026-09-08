import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import identities from './processIdentity.cjs';
import scopes from './processScope.cjs';
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const stopError = (message) => Object.assign(new Error(message), { reason: 'processStopFailed' });
export const spawnManaged = scopes.spawnManaged;
export const listProcesses = async (platform = process.platform) => identities.listProcesses(platform);
const same = identities.sameProcess;

function readRecords(directory, root) {
  const all = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({
    ...JSON.parse(readFileSync(path.join(directory, name), 'utf8')), entry: name.slice(0, -5),
  }));
  if (!root) return all;
  const owned = new Set([root]);
  let changed;
  do { changed = false; for (const item of all) if (owned.has(item.parent) && !owned.has(item.entry)) { owned.add(item.entry); changed = true; } } while (changed);
  return all.filter(item => owned.has(item.entry));
}

async function stopRegisteredTree(child, {
  platform = process.platform, graceMs = 1500, forceMs = 3000,
  inspect = () => platform === 'win32'
    ? identities.getProcessIdentities([...new Set(records().flatMap(entry => [entry.identity?.pid, entry.job?.holder].filter(Boolean)))], platform)
    : listProcesses(platform), signal = (pid, name) => process.kill(pid, name),
  scope = child[scopes.KEY], records = () => readRecords(scope.directory, scope.entry),
  closeScope = () => { try { mkdirSync(path.join(scope.directory, scope.entry ? `${scope.entry}.closing` : 'closing')); } catch (error) { if (error.code !== 'EEXIST') throw error; } },
  cleanup = () => {
    const owned = readRecords(scope.directory, scope.entry);
    for (const record of owned) scopes.writeRecord(path.join(scope.directory, `${record.entry}.json`), { state: 'done', parent: record.parent });
    if (!scope.entry || owned.find(record => record.entry === scope.entry)?.parent === null) rmSync(scope.directory, { recursive: true, force: true });
  },
} = {}) {
  // An exited ChildProcess with an old PID is NOT an ownership certificate.
  if (!scope) throw stopError('Managed process ownership was not registered at launch.');
  const known = new Map();
  const guards = new Map();
  const forceKilledGuards = new Set();
  let pending = false;
  let uncertain = false;
  const snapshot = async () => {
    let entries = records();
    const root = entries.find(entry => entry.entry === scope.entry) || entries.find(entry => entry.parent === null);
    // Closing the root Job proves all nested jobs and holders have exited too.
    if (platform === 'win32' && root?.job && existsSync(root.job.stopped)) {
      if (!root.job.holderIdentity) throw new Error('Windows Job supervisor identity unavailable');
      pending = (await inspect()).some(row => same(root.job.holderIdentity, row));
      return [];
    }
    const holders = new Set(entries.flatMap(entry => entry.job?.holder ? [entry.job.holder] : []));
    entries = entries.filter(entry => !(entry.job && existsSync(entry.job.stopped)));
    const rows = (await inspect()).filter(row => !holders.has(row.pid));
    pending = entries.some(entry => entry.state === 'pending' || (entry.job && !existsSync(entry.job.stopped)));
    for (const entry of entries.filter(entry => entry.state === 'active' || entry.state === 'exiting')) {
      uncertain ||= Boolean(entry.uncertain);
      const current = rows.find(row => row.pid === entry.identity.pid);
      if (guards.has(entry.identity.pid) && !same(entry.identity, current) && !entry.job && !forceKilledGuards.has(entry.identity.pid)) uncertain = true;
      if (!guards.has(entry.identity.pid)) {
        if (!same(entry.identity, current)) { if (!entry.job) uncertain = true; continue; }
        guards.set(current.pid, current);
        known.set(current.pid, current);
      }
      for (const member of entry.members || []) {
        if (same(member, rows.find(row => row.pid === member.pid))) known.set(member.pid, member);
      }
    }
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        const guard = guards.get(row.group);
        const parent = known.get(row.parent);
        const owned = (platform !== 'win32' && guard && same(guard, rows.find(item => item.pid === guard.pid)))
          || (parent && same(parent, rows.find(item => item.pid === parent.pid)));
        if (owned && !known.has(row.pid)) { known.set(row.pid, row); changed = true; }
      }
    } while (changed);
    return rows.filter(row => !row.zombie && same(known.get(row.pid), row));
  };
  const waitForExit = async duration => {
    const deadline = Date.now() + duration;
    do {
      const living = await snapshot();
      if (!living.length && !pending) return true;
      if (Date.now() >= deadline) return false;
      await pause(50);
    } while (true);
  };
  const send = async name => {
    const living = await snapshot();
    if (platform === 'win32') {
      for (const entry of records().filter(entry => entry.state === 'active' || entry.state === 'exiting')) {
        if (!entry.job) throw new Error('Windows Job ownership was not established.');
        if (!existsSync(entry.job.stopped)) writeFileSync(entry.job.stop, 'stop', { mode: 0o600 });
      }
      return;
    }
    const groups = new Set();
    for (const row of living) {
      // Revalidate immediately before each signal, including group leaders.
      const fresh = await inspect();
      if (!same(row, fresh.find(item => item.pid === row.pid))) continue;
      const guard = guards.get(row.group);
      const groupOwned = guard && same(guard, fresh.find(item => item.pid === guard.pid));
      if (groupOwned && groups.has(row.group)) continue;
      try {
        signal(groupOwned ? -row.group : row.pid, name);
        if (groupOwned && name === 'SIGKILL') forceKilledGuards.add(guard.pid);
      }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (groupOwned) groups.add(row.group);
    }
  };
  try {
    closeScope();
    // Let launchers racing shutdown register or cancel before signalling. A
    // crashed launcher leaves 'pending', which causes a bounded, explicit error.
    const registrationDeadline = scope.startupDeadline || Date.now() + forceMs;
    while ((await snapshot(), records().some(entry => entry.state === 'pending' || (entry.job && !existsSync(entry.job.ready) && !existsSync(entry.job.stopped)))) && Date.now() < registrationDeadline) await pause(50);
    await send('SIGTERM');
    if (!(await waitForExit(graceMs))) {
      await send('SIGKILL');
      if (!(await waitForExit(forceMs))) throw new Error('Managed processes or pending launches remain.');
    }
    if (uncertain) throw new Error('Process ownership or descendant cleanup could not be confirmed.');
    cleanup();
    scope.stopped = true;
  } catch (error) { throw stopError(error.message); }
}

export function stopProcessTree(child, options = {}) {
  const scope = options.scope || child[scopes.KEY];
  if (scope?.stopped) return Promise.resolve();
  if (scope?.stopping) return scope.stopping;
  const pending = stopRegisteredTree(child, options);
  if (!scope) return pending;
  scope.stopping = pending.finally(() => { scope.stopping = null; });
  return scope.stopping;
}

export function runManagedCommand(command, args, {
  cwd, env = process.env, progress = () => {}, timeoutMs = 15 * 60 * 1000,
  stop = stopProcessTree,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnManaged(command, args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      shell: process.platform === 'win32', windowsHide: true,
    });
    let finishing = false;
    const finish = async (failure) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      try {
        if (child.pid) await stop(child);
        if (failure) reject(failure); else resolve();
      } catch (error) { reject(error); }
      finally {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
    };
    // Independent from 'close': a grandchild holding stdout open must not keep
    // the update promise (and its lock) pending after the timeout.
    const timer = setTimeout(() => void finish(Object.assign(new Error(`${command} timed out.`), { reason: 'buildTimedOut' })), timeoutMs);
    child.stdout.on('data', data => progress(data.toString()));
    child.stderr.on('data', data => progress(data.toString()));
    child.once('error', error => void finish(error));
    child.once('managed-exit', (code, _signal, startupError) => void finish(code === 0 ? null : Object.assign(new Error(startupError || `${command} failed (${code}).`), { reason: startupError ? 'processStartFailed' : 'buildFailed' })));
  });
}
