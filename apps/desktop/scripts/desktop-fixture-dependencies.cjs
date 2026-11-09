const fs = require('node:fs');
const path = require('node:path');
const { copyFilesSync } = require('./copy-files.cjs');

// Copy production modules into the temporary app. Do not depend on module
// resolution escaping the fixture and finding a developer's workspace packages.
function copyDesktopFixtureDependencies(root, runtime) {
  const desktop = path.resolve(__dirname, '..');
  const copyPackage = (name, destination, searchRoot) => {
    const source = path.dirname(require.resolve(`${name}/package.json`, { paths: [searchRoot] }));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyFilesSync(source, destination, { recursive: true, dereference: true });
  };
  copyPackage('@pilotdeck/config', path.join(root, 'node_modules', '@pilotdeck', 'config'), desktop);
  copyPackage('yaml', path.join(runtime, 'node_modules', 'yaml'), path.resolve(desktop, '../..'));
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(desktop, 'resources', 'uninstall-data.cjs'), path.join(root, 'resources', 'uninstall-data.cjs'));

  const utils = path.join(runtime, 'ui', 'server', 'utils');
  fs.mkdirSync(utils, { recursive: true });
  for (const name of ['processTree.js', 'processIdentity.cjs', 'processScope.cjs', 'processGuardian.cjs',
    'processJobHost.cjs', 'processJob.ps1', 'nativeProcessHost.cjs', 'processHost.cs']) {
    fs.copyFileSync(path.resolve(desktop, '../../ui/server/utils', name), path.join(utils, name));
  }
}

module.exports = { copyDesktopFixtureDependencies };
