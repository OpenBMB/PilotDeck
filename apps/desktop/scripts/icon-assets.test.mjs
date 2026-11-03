import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';

const icons = new URL('../resources/icons/', import.meta.url);
async function filledCanvas(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, info.height);
  const mid = Math.floor(info.width / 2);
  for (const [x, y] of [[0, mid], [info.width - 1, mid], [mid, 0], [mid, info.height - 1]]) {
    const offset = (y * info.width + x) * 4;
    assert.ok(data[offset + 3] > 240, 'artwork must reach every side of its canvas');
    assert.ok(data[offset] < 80 && data[offset + 2] > data[offset], 'edges must retain the navy brand fill, without a white plate');
  }
}
test('Linux PNG and every macOS ICNS representation fill the canonical canvas', async () => {
  const png = fs.readFileSync(new URL('icon.png', icons));
  assert.equal((await sharp(png).metadata()).width, 1024);
  await filledCanvas(png);
  const icns = fs.readFileSync(new URL('icon.icns', icons));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  let entries = 0;
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    await filledCanvas(icns.subarray(offset + 8, offset + length));
    offset += length; entries++;
  }
  assert.equal(entries, 11);
});
test('all Windows ICO sizes fill their canvas, including fractional DPI sizes', async () => {
  const ico = fs.readFileSync(new URL('icon.ico', icons));
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16, size = ico[entry] || 256, offset = ico.readUInt32LE(entry + 12);
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const source = offset + 40 + ((size - y - 1) * size + x) * 4, target = (y * size + x) * 4;
      rgba[target] = ico[source + 2]; rgba[target + 1] = ico[source + 1]; rgba[target + 2] = ico[source]; rgba[target + 3] = ico[source + 3];
    }
    await filledCanvas(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
    sizes.push(size);
  }
  assert.ok(sizes.includes(20) && sizes.includes(24) && sizes.includes(40));
});
test('Windows ships an explicit Start/Search tile with a matching background and full-size artwork', () => {
  const manifest = fs.readFileSync(new URL('../resources/PilotDeck.VisualElementsManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /BackgroundColor="#0B2353"/);
  for (const name of ['Square150x150Logo', 'Square70x70Logo']) assert.ok(manifest.includes(`${name}="resources\\icons\\icon.png"`));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.ok(pkg.build.win.extraFiles.some(file => file.to === 'PilotDeck.VisualElementsManifest.xml'));
});

test('Linux packaging resolves full-canvas icons at every standard launcher size', async () => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { convertIcon } = builderRequire('app-builder-lib/out/util/iconConverter.js');
  const desktop = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-linux-icons-'));
  try {
    const { icons: resolved } = await convertIcon({ sources: [pkg.build.linux.icon], fallbackSources: [],
      roots: [desktop], format: 'set', outDir: output });
    assert.deepEqual(resolved.map(icon => icon.size), [16, 32, 48, 64, 128, 256, 512]);
    for (const icon of resolved) {
      const metadata = await sharp(icon.file).metadata();
      assert.equal(metadata.width, icon.size);
      await filledCanvas(icon.file);
    }
  } finally {
    assert.ok(path.resolve(output).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(output, { recursive: true, force: true });
  }
});
