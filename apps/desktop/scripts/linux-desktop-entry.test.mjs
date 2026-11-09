import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { LinuxTargetHelper } = builderRequire('app-builder-lib/out/targets/LinuxTargetHelper.js');
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('generated Linux launcher declares every desktop action and preserves localized uninstall', async () => {
  // Exercise the installed electron-builder generator without building a binary.
  const helper = Object.create(LinuxTargetHelper.prototype);
  helper.packager = {
    appInfo: { productName: 'PilotDeck', sanitizedProductName: 'PilotDeck', description: metadata.description },
    info: { metadata }, config: metadata.build,
    platformSpecificBuildOptions: metadata.build.linux,
    executableName: metadata.desktopName, fileAssociations: [],
  };
  const text = await helper.computeDesktopEntry(metadata.build.linux);
  const sections = new Map();
  let section;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[') && line.endsWith(']')) {
      section = new Map(); sections.set(line.slice(1, -1), section);
    } else if (line.includes('=')) {
      const split = line.indexOf('='); section.set(line.slice(0, split), line.slice(split + 1));
    }
  }
  const actions = sections.get('Desktop Entry').get('Actions').split(';').filter(Boolean);
  assert.deepEqual(actions, ['Uninstall']);
  for (const action of actions) assert.ok(sections.has(`Desktop Action ${action}`));
  for (const key of sections.keys()) if (key.startsWith('Desktop Action ')) assert.ok(actions.includes(key.slice('Desktop Action '.length)));
  const uninstall = sections.get('Desktop Action Uninstall');
  assert.equal(uninstall.get('Name'), 'Uninstall PilotDeck');
  assert.equal(uninstall.get('Name[zh_CN]'), '卸载 PilotDeck');
  assert.equal(uninstall.get('Exec'), 'pilotdeck-desktop --uninstall');
});
