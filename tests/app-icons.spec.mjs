import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {writeIcns} from '../scripts/lib/app-icons.mjs';

test('component and main icons provide decodable standard and Retina sizes', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-icons-'));
  try {
    for (const source of ['scripts/computer-use/icon.png', 'apps/desktop/resources/icons/icon-source.png']) {
      const file = path.join(temporary, 'icon.icns'); await writeIcns(source, file);
      const bytes = fs.readFileSync(file); assert.equal(bytes.toString('ascii', 0, 4), 'icns');
      assert.equal(bytes.readUInt32BE(4), bytes.length);
      const entries = new Map();
      for (let cursor = 8; cursor < bytes.length;) {
        const size = bytes.readUInt32BE(cursor + 4), type = bytes.toString('ascii', cursor, cursor + 4);
        assert.ok(size > 8 && cursor + size <= bytes.length);
        const metadata = await sharp(bytes.subarray(cursor + 8, cursor + size)).metadata();
        assert.equal(metadata.format, 'png'); assert.equal(metadata.width, metadata.height);
        entries.set(type, metadata.width); cursor += size;
      }
      assert.deepEqual(new Set(entries.values()), new Set([16, 32, 64, 128, 256, 512, 1024]));
      assert.equal(entries.get('ic11'), 32); assert.equal(entries.get('ic12'), 64);
      assert.equal(entries.get('ic13'), 256); assert.equal(entries.get('ic14'), 512);
    }
  } finally {fs.rmSync(temporary, {recursive:true, force:true});}
});
