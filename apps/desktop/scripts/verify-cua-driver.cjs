// Run with the packaged Node runtime after installation/extraction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function verifyCuaDriver(resources, expectedArch) {
  const pinned = require('../../../scripts/computer-use/cua-driver.json');
  const directory = path.join(resources, 'runtime', 'resources', 'cua-driver');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pinned.version);
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, expectedArch);
  const asset = pinned.assets[process.platform === 'darwin' ? 'darwin' : `${process.platform}-${expectedArch}`];
  assert.equal(manifest.archiveSha256, asset.sha256);
  const binary = path.join(directory, process.platform === 'darwin' ? 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver' : process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim().split(/\s+/)[1], pinned.version);
  assert.match(fs.readFileSync(path.join(directory, 'LICENSE.txt'), 'utf8'), /MIT License/);
  if (process.platform === 'darwin') {
    const app = path.join(directory, 'PilotDeck Computer Use.app');
    const info = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
    assert.match(info, /cn\.pilotdeck\.computer-use/);
    assert.match(info, /computer-use\.icns/);
    assert.match(info, /PilotDeck Computer Use/);
    const icon = fs.readFileSync(path.join(app, 'Contents/Resources/computer-use.icns'));
    assert.equal(icon.toString('ascii', 0, 4), 'icns');
    assert.equal(icon.readUInt32BE(4), icon.length);
    const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' });
    assert.equal(signature.status, 0, 'The permission helper must be signed');
    assert.match(signature.stderr, /^Identifier=cn\.pilotdeck\.computer-use$/m);
    if (process.env.PILOTDECK_DESKTOP_REQUIRE_SIGNING === '1') {
      assert.match(signature.stderr, /^Authority=Developer ID Application:/m);
      const outerApp = path.resolve(resources, '..', '..');
      const outerSignature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', outerApp], { encoding: 'utf8' });
      assert.equal(outerSignature.status, 0);
      const helperTeam = signature.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
      const desktopTeam = outerSignature.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
      assert.ok(helperTeam && helperTeam !== 'not set', 'A production permission helper needs a signing team');
      assert.equal(helperTeam, desktopTeam, 'The helper and desktop must use the same production signing team');
    }
  }
  console.log(`PASS: bundled Cua Driver ${pinned.version} (${process.platform}/${expectedArch})`);
}

module.exports = { verifyCuaDriver };
if (require.main === module) verifyCuaDriver(path.resolve(process.argv[2]), process.argv[3]);
