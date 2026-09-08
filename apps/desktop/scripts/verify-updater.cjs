// Run with the packaged Electron executable in ELECTRON_RUN_AS_NODE mode so
// dependency resolution uses the real app.asar filesystem, not the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const archive = fs.realpathSync(path.resolve(process.argv[2]));
const packagedRequire = createRequire(path.join(archive, 'package.json'));
const entry = packagedRequire.resolve('electron-updater');
assert.ok(entry.startsWith(archive + path.sep), 'electron-updater resolved outside the packaged app');
const updater = packagedRequire('electron-updater');
assert.equal(typeof updater.MacUpdater, 'function');
assert.equal(typeof updater.NsisUpdater, 'function');
assert.equal(typeof packagedRequire('./dist/updates.js').createUpdateController, 'function');
const visited = new Set();
function inspect(module) {
  if (!module || visited.has(module.id)) return;
  visited.add(module.id);
  if (module.filename && module.filename.includes(`${path.sep}node_modules${path.sep}`)) {
    assert.ok(module.filename.startsWith(archive + path.sep), `Dependency escaped app.asar: ${module.filename}`);
  }
  for (const child of module.children) inspect(child);
}
inspect(require.cache[entry]);
assert.ok(fs.existsSync(path.join(path.dirname(archive), 'app-update.yml')), 'Missing updater cache/publisher configuration');
console.log(`Verified packaged updater and ${visited.size} loaded modules.`);
