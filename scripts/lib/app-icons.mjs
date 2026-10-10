import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

// macOS 13+ accepts PNG-backed ICNS entries. Build every standard and Retina
// size from one source so small system-list icons cannot use stale artwork.
export async function writeIcns(source, destination) {
  const entries = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
    ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const rendered = new Map();
  const chunks = [];
  for (const [type, size] of entries) {
    if (!rendered.has(size)) rendered.set(size, await sharp(source).resize(size, size).png().toBuffer());
    const png = rendered.get(size);
    const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }
  const content = Buffer.concat(chunks);
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(content.length + 8, 4);
  writeFileSync(destination, Buffer.concat([header, content]));
}
