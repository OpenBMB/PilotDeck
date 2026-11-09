// Used before Windows removes the bundled Node, and after Linux package removal.
// Deliberately accepts only PilotDeck-owned directory names, never arbitrary homes.
const fs = require('node:fs');
const path = require('node:path');

function containsWorkspace(directory) {
  const pending = [directory];
  while (pending.length) {
    for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
      if (entry.name === '.pilotdeck-workspace') return true;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(entry.parentPath || entry.path, entry.name));
    }
  }
  return false;
}

function cleanupPersonalData({ profile, appData, localAppData, pilotHome }) {
  const home = path.resolve(profile), targets = new Set(), skipped = [], removed = [];
  if (home === path.parse(home).root) return { removed, skipped: [home] };
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const inside = (base, target) => { const relative = path.relative(base, target); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const pilot = path.resolve(pilotHome || path.join(home, '.pilotdeck'));
  if (path.basename(pilot).toLowerCase() === '.pilotdeck' && !same(pilot, home) && !same(pilot, path.parse(pilot).root)) targets.add(pilot);
  else skipped.push(pilot);
  for (const [base, names] of [[appData, ['PilotDeck', 'pilotdeck-desktop']], [localAppData, ['PilotDeck', 'pilotdeck-desktop', 'pilotdeck-desktop-updater', 'pilotdeck-updater']]]) {
    if (!base) continue;
    const absolute = path.resolve(base);
    if (!inside(home, absolute)) { skipped.push(absolute); continue; }
    for (const name of names) targets.add(path.join(absolute, name));
  }
  for (const target of targets) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) { fs.unlinkSync(target); removed.push(target); continue; }
      if (!stat.isDirectory() || fs.existsSync(path.join(target, '.git'))) { skipped.push(target); continue; }
      // Resolve before every recursive removal. Redirected ancestors must not
      // turn a user's cache path into another user's or a system directory.
      const canonical = fs.realpathSync(target);
      if (!same(canonical, target)) { skipped.push(target); continue; }
      if (containsWorkspace(canonical)) { skipped.push(target); continue; }
      fs.rmSync(canonical, { recursive: true, force: true, maxRetries: 2 });
      removed.push(target);
    } catch (error) { if (error.code !== 'ENOENT') skipped.push(target); }
  }
  return { removed, skipped };
}

function readClientLanguage({ profile, appData }) {
  if (!appData) return '';
  const relative = path.relative(path.resolve(profile), path.resolve(appData));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  const files = ['PilotDeck', 'pilotdeck-desktop'].map(name => path.join(appData, name, 'appearance.json'));
  const candidates = files.flatMap(file => { try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size < 65536 ? [{ file, at: stat.mtimeMs }] : []; } catch { return []; } }).sort((a,b) => b.at - a.at);
  for (const { file } of candidates) {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')).language; if (value === 'en' || value === 'zh-CN') return value; } catch {}
  }
  return '';
}

module.exports = { cleanupPersonalData, readClientLanguage };
if (require.main === module) {
  const args = process.argv.slice(2), get = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const profile = get('--profile');
  if (!profile || !path.isAbsolute(profile)) process.exitCode = 2;
  else if (args.includes('--language')) {
    process.stdout.write(readClientLanguage({ profile, appData: get('--app-data') }));
  } else {
    const result = cleanupPersonalData({ profile, appData: get('--app-data'), localAppData: get('--local-app-data'), pilotHome: get('--pilot-home') });
    process.stdout.write(JSON.stringify(result));
    if (result.skipped.length) process.exitCode = 2;
  }
}
