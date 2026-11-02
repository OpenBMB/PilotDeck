import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import sharp from "sharp";

export type ImagePurpose = "intermediate" | "deliverable";
export type GeneratedImage = {
  imageId: string; sessionId: string; mimeType: string; width: number; height: number;
  bytes: number; path: string; savedTo?: string; purpose?: ImagePurpose;
};

/** Durable session attachments. Never stored below the user's project. */
export class ImageStore {
  private readonly inheritance = new Map<string, Promise<GeneratedImage>>();
  constructor(readonly root: string) {}
  private directory(sessionId: string): string {
    return join(resolve(this.root), createHash("sha256").update(sessionId).digest("hex"));
  }
  async save(sessionId: string, bytes: Buffer, signal?: AbortSignal, purpose: ImagePurpose = "deliverable"): Promise<GeneratedImage> {
    const meta = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
    const mimeType = ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[meta.format ?? ""];
    if (!mimeType || !meta.width || !meta.height) throw new Error("The image service returned unsupported or invalid image data.");
    const imageId = randomUUID();
    const dir = this.directory(sessionId);
    const image: GeneratedImage = { imageId, sessionId, mimeType, width: meta.width, height: meta.height, bytes: bytes.length, purpose,
      path: join(dir, `${imageId}.${meta.format === "jpeg" ? "jpg" : meta.format}`) };
    await this.persist(image, bytes, signal);
    return image;
  }
  /** Copy an explicitly inherited asset; never fall back to other sessions on lookup. */
  async inherit(sourceSessionId: string, imageId: string, targetSessionId: string): Promise<GeneratedImage> {
    const source = await this.get(sourceSessionId, imageId);
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[source.mimeType];
    if (!extension) throw new Error("Invalid image MIME type.");
    const image = { ...source, sessionId: targetSessionId, path: join(this.directory(targetSessionId), `${imageId}.${extension}`) };
    await this.persist(image, await readFile(source.path));
    return image;
  }
  /** Idempotent handoff; serialize replays and verify any existing original before reusing it. */
  async inheritOnce(sourceSessionId: string, imageId: string, targetSessionId: string): Promise<GeneratedImage> {
    const key = JSON.stringify([targetSessionId, imageId]);
    const pending = this.inheritance.get(key);
    if (pending) {
      await pending.catch(() => {});
      return this.inheritOnce(sourceSessionId, imageId, targetSessionId);
    }
    const operation = (async () => {
      const source = await this.get(sourceSessionId, imageId);
      let existing: GeneratedImage;
      try { existing = await this.get(targetSessionId, imageId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return this.inherit(sourceSessionId, imageId, targetSessionId);
      }
      if (existing.mimeType !== source.mimeType || existing.width !== source.width || existing.height !== source.height
        || !(await readFile(existing.path)).equals(await readFile(source.path))) {
        throw new Error("Inherited image conflicts with the existing session attachment.");
      }
      return existing;
    })();
    this.inheritance.set(key, operation);
    try { return await operation; }
    finally { if (this.inheritance.get(key) === operation) this.inheritance.delete(key); }
  }
  private async persist(image: GeneratedImage, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(image.path), { recursive: true, mode: 0o700 });
    const manifestPath = join(this.directory(image.sessionId), `${image.imageId}.json`);
    const created: string[] = [];
    const writeExclusive = async (file: string, content: Buffer | string) => {
      const handle = await open(file, "wx", 0o600);
      created.push(file);
      try { await handle.writeFile(content, { signal }); }
      finally { await handle.close(); }
    };
    try {
      await writeExclusive(image.path, bytes);
      await writeExclusive(manifestPath, JSON.stringify(image));
      signal?.throwIfAborted();
    } catch (error) {
      await Promise.all(created.map(path => unlink(path).catch(() => {})));
      throw error;
    }
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
