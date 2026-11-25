/** Fit an encoded image to its byte budget using the existing resize and quality passes. */
export async function compressImageToFit(
  buffer: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
  let output = buffer;
  let outputMimeType = mimeType;
  if (output.byteLength > maxBytes) {
    try {
      const sharpModule = await import("sharp");
      const sharp = sharpModule.default;
      const pipeline = sharp(buffer).rotate();
      if (mimeType === "image/png") {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        outputMimeType = "image/png";
      } else if (mimeType === "image/webp") {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        outputMimeType = "image/webp";
      } else if (mimeType === "image/gif") {
        output = await pipeline
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        outputMimeType = "image/png";
      } else {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }

      if (output.byteLength > maxBytes) {
        output = await sharp(output)
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 55 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }

      if (output.byteLength > maxBytes) {
        output = await sharp(output)
          .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 40 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }
    } catch {
      // Fall back to the original bytes when image compression is unavailable.
    }
  }

  if (output.byteLength > maxBytes) return undefined;
  return { buffer: output, mimeType: outputMimeType };
}
