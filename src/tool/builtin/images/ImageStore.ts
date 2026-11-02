import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import sharp from "sharp";

export type GeneratedImage = {
  imageId: string; sessionId: string; mimeType: string; width: number; height: number;
  bytes: number; path: string; savedTo?: string;
};

/** Durable session attachments. Never stored below the user's project. */
export class ImageStore {
  constructor(readonly root: string) {}
  private directory(sessionId: string): string {
    return join(resolve(this.root), createHash("sha256").update(sessionId).digest("hex"));
  }
  async save(sessionId: string, bytes: Buffer, signal?: AbortSignal): Promise<GeneratedImage> {
    const meta = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
    const mimeType = ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[meta.format ?? ""];
    if (!mimeType || !meta.width || !meta.height) throw new Error("The image service returned unsupported or invalid image data.");
    const imageId = randomUUID();
    const dir = this.directory(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const image: GeneratedImage = { imageId, sessionId, mimeType, width: meta.width, height: meta.height, bytes: bytes.length,
      path: join(dir, `${imageId}.${meta.format === "jpeg" ? "jpg" : meta.format}`) };
    const manifestPath = join(dir, `${imageId}.json`);
    try {
      await writeFile(image.path, bytes, { flag: "wx", mode: 0o600, signal });
      await writeFile(manifestPath, JSON.stringify(image), { flag: "wx", mode: 0o600, signal });
      signal?.throwIfAborted();
    } catch (error) {
      await Promise.all([image.path, manifestPath].map(path => unlink(path).catch(() => {})));
      throw error;
    }
    return image;
  }
  async get(sessionId: string, imageId: string): Promise<GeneratedImage> {
    if (!/^[0-9a-f-]{36}$/.test(imageId)) throw new Error("Invalid image ID.");
    const dir = this.directory(sessionId);
    const image = JSON.parse(await readFile(join(dir, `${imageId}.json`), "utf8")) as GeneratedImage;
    if (image.sessionId !== sessionId || image.imageId !== imageId) throw new Error("Image does not belong to this session.");
    const rel = relative(await realpath(dir), await realpath(image.path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid image attachment path.");
    return image;
  }
}
