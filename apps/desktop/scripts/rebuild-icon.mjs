/**
 * Rebuild icon.ico / icon.png / installer-icon.ico from icon-source.png.
 *
 * icon.ico        – full multi-res ICO (256..16) for app exe (rcedit)
 * installer-icon.ico – compact ICO (48/32/16 BMP only) for NSIS installer
 * icon.png        – 256x256 PNG for macOS / general use
 *
 * All ICO entries use BMP encoding (no PNG compression) for maximum
 * NSIS compatibility. NSIS 3.x cannot reliably use PNG-in-ICO for the
 * installer exe title bar icon.
 *
 * Usage:  node scripts/rebuild-icon.mjs
 */

import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, "..", "resources", "icons");
const SOURCE = join(ICONS_DIR, "icon-source.png");

const ICO_SIZES = [256, 128, 64, 48, 32, 16];

async function makeIcon(size) {
  const buf = await sharp(SOURCE)
    .resize(size, size, {
      fit: "cover",
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .raw()
    .toBuffer();

  return { rgba: buf, size };
}

/**
 * Convert RGBA pixel buffer to BMP-encoded ICO entry.
 * ICO BMP format: BITMAPINFOHEADER (40 bytes) + BGRA pixels (bottom-up) + AND mask.
 */
function rgbaToBmpIcoEntry(rgba, size) {
  const bpp = 32;
  const rowBytes = size * 4;
  const andMaskRowBytes = Math.ceil(size / 8);
  const andMaskRowPadded = (andMaskRowBytes + 3) & ~3;
  const andMaskSize = andMaskRowPadded * size;
  const pixelDataSize = rowBytes * size;

  // BITMAPINFOHEADER (40 bytes)
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(size, 4);         // biWidth
  header.writeInt32LE(size * 2, 8);     // biHeight (doubled for ICO: XOR + AND)
  header.writeUInt16LE(1, 12);          // biPlanes
  header.writeUInt16LE(bpp, 14);        // biBitCount
  header.writeUInt32LE(0, 16);          // biCompression = BI_RGB
  header.writeUInt32LE(pixelDataSize + andMaskSize, 20); // biSizeImage
  // Remaining fields (biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant) = 0

  // Pixel data: convert RGBA (top-down) to BGRA (bottom-up)
  const pixels = Buffer.alloc(pixelDataSize);
  for (let y = 0; y < size; y++) {
    const srcRow = y * rowBytes;
    const dstRow = (size - 1 - y) * rowBytes;
    for (let x = 0; x < size; x++) {
      const srcOff = srcRow + x * 4;
      const dstOff = dstRow + x * 4;
      pixels[dstOff + 0] = rgba[srcOff + 2]; // B
      pixels[dstOff + 1] = rgba[srcOff + 1]; // G
      pixels[dstOff + 2] = rgba[srcOff + 0]; // R
      pixels[dstOff + 3] = rgba[srcOff + 3]; // A
    }
  }

  // AND mask: 1-bit per pixel (0 = opaque, 1 = transparent), bottom-up
  const andMask = Buffer.alloc(andMaskSize, 0);
  for (let y = 0; y < size; y++) {
    const srcRow = y * rowBytes;
    const dstRow = (size - 1 - y) * andMaskRowPadded;
    for (let x = 0; x < size; x++) {
      const alpha = rgba[srcRow + x * 4 + 3];
      if (alpha < 128) {
        const byteIdx = dstRow + (x >> 3);
        const bitIdx = 7 - (x & 7);
        andMask[byteIdx] |= (1 << bitIdx);
      }
    }
  }

  return Buffer.concat([header, pixels, andMask]);
}

/**
 * Pack image entries into a Windows ICO file.
 * 256x256 uses PNG compression; smaller sizes use BMP encoding.
 */
function buildIco(entries) {
  const headerSize = 6;
  const dirEntrySize = 16;
  const count = entries.length;
  let dataOffset = headerSize + dirEntrySize * count;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const dataBlobs = [];

  for (const entry of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(entry.data.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dataOffset += entry.data.length;
    dirEntries.push(dir);
    dataBlobs.push(entry.data);
  }

  return Buffer.concat([header, ...dirEntries, ...dataBlobs]);
}

async function main() {
  mkdirSync(ICONS_DIR, { recursive: true });

  console.log("Generating icons from", SOURCE);

  const icoEntries = [];
  let png256 = null;

  for (const size of ICO_SIZES) {
    const { rgba, size: s } = await makeIcon(size);

    // All sizes use BMP encoding for maximum NSIS compatibility.
    // PNG-in-ICO causes NSIS to fail setting the .exe title bar icon.
    const bmpData = rgbaToBmpIcoEntry(rgba, s);
    icoEntries.push({ size, data: bmpData });
    console.log(`  ${size}x${size}: ${bmpData.length} bytes (BMP)`);

    if (size === 256) {
      png256 = await sharp(rgba, { raw: { width: s, height: s, channels: 4 } })
        .png()
        .toBuffer();
    }
  }

  // Write full icon.ico (all sizes, for app exe via rcedit)
  const icoPath = join(ICONS_DIR, "icon.ico");
  const icoBuf = buildIco(icoEntries);
  writeFileSync(icoPath, icoBuf);
  console.log(`Wrote ${icoPath} (${icoBuf.length} bytes)`);

  // Write compact installer-icon.ico (48/32/16 only, for NSIS installer)
  const installerEntries = icoEntries.filter((e) => e.size <= 48);
  const installerIcoPath = join(ICONS_DIR, "installer-icon.ico");
  const installerIcoBuf = buildIco(installerEntries);
  writeFileSync(installerIcoPath, installerIcoBuf);
  console.log(`Wrote ${installerIcoPath} (${installerIcoBuf.length} bytes)`);

  // Write icon.png (256x256 with transparency)
  const pngPath = join(ICONS_DIR, "icon.png");
  writeFileSync(pngPath, png256);
  console.log(`Wrote ${pngPath} (${png256.length} bytes)`);

  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
