import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, realpath, stat, unlink, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

export type VideoPurpose = "intermediate" | "deliverable";
export type GeneratedVideo = {
  videoId: string; sessionId: string; mimeType: "video/mp4"; bytes: number; sha256: string;
  path: string; savedTo?: string; purpose: VideoPurpose;
};
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

/** Durable, session-scoped MP4 attachments; large files are always streamed. */
export class VideoStore {
  private readonly inheritance = new Map<string, Promise<GeneratedVideo>>();
  constructor(readonly root: string) {}
  private directory(sessionId: string): string { return join(resolve(this.root), createHash("sha256").update(sessionId).digest("hex")); }
  async list(sessionId: string): Promise<GeneratedVideo[]> {
    let names: string[];
    try { names = await readdir(this.directory(sessionId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const videos: GeneratedVideo[] = [];
    for (const name of names.sort()) if (/^[0-9a-f-]{36}\.json$/.test(name)) {
      try { videos.push(await this.get(sessionId, name.slice(0, -5))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return videos;
  }
  async save(sessionId: string, response: Response, signal?: AbortSignal, purpose: VideoPurpose = "deliverable", videoId: string = randomUUID()): Promise<GeneratedVideo> {
    if (!/^[0-9a-f-]{36}$/.test(videoId)) throw new Error("Invalid video ID.");
    const dir = this.directory(sessionId);
    const path = join(dir, videoId + ".mp4");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const existing = await this.get(sessionId, videoId);
      await response.body?.cancel();
      return existing;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // The durable job owns a process lease while saving this identity. Remove
    // abandoned chunks left by its previous process before downloading again.
    for (const name of await readdir(dir)) if (name.startsWith(videoId + ".") && name.endsWith(".partial")) {
      await unlink(join(dir, name)).catch(() => {});
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Video service returned no video.");
    let bytes = 0; const digest = createHash("sha256"); let header = Buffer.alloc(0);
    // A retry publishes the same attachment identity. Incomplete downloads
    // never occupy the final file, including after a process crash.
    const staging = `${path}.${randomUUID()}.partial`;
    const handle = await open(staging, "wx", 0o600); let published = false;
    const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted(); const { done, value } = await reader.read(); signal?.throwIfAborted(); if (done) break;
        bytes += value.length; if (bytes > MAX_VIDEO_BYTES) throw new Error("Video exceeds the 512 MB attachment limit.");
        if (header.length < 12) header = Buffer.concat([header, Buffer.from(value).subarray(0, 12 - header.length)]);
        digest.update(value); await handle.writeFile(value);
      }
      if (bytes < 16 || header.toString("ascii", 4, 8) !== "ftyp") throw new Error("Video service returned invalid MP4 data.");
      await handle.close();
      const video: GeneratedVideo = { videoId, sessionId, mimeType: "video/mp4", bytes, sha256: digest.digest("hex"), path, purpose };
      await rename(staging, path);
      published = true;
      await this.manifest(video, signal); return video;
    } catch (error) { await handle.close().catch(() => {}); if (published) await unlink(path).catch(() => {}); throw error; }
    finally { await unlink(staging).catch(() => {}); signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
  }
  private async manifest(video: GeneratedVideo, signal?: AbortSignal) {
    const target = join(this.directory(video.sessionId), video.videoId + ".json");
    const staging = `${target}.${randomUUID()}.tmp`; let published = false;
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(video), { signal }); await handle.close(); signal?.throwIfAborted();
      await link(staging, target); published = true; signal?.throwIfAborted();
    } catch (error) { if (published) await unlink(target).catch(() => {}); throw error; }
    finally { await handle.close().catch(() => {}); await unlink(staging).catch(() => {}); }
  }
  async get(sessionId: string, videoId: string): Promise<GeneratedVideo> {
    if (!/^[0-9a-f-]{36}$/.test(videoId)) throw new Error("Invalid video ID.");
    const dir = this.directory(sessionId);
    const video = JSON.parse(await readFile(join(dir, videoId + ".json"), "utf8")) as GeneratedVideo;
    if (video.sessionId !== sessionId || video.videoId !== videoId || video.mimeType !== "video/mp4") throw new Error("Video does not belong to this session.");
    const rel = relative(await realpath(dir), await realpath(video.path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid video attachment path.");
    if ((await stat(video.path)).size !== video.bytes) throw new Error("Video attachment is incomplete.");
    return video;
  }
  async inherit(sourceSessionId: string, videoId: string, targetSessionId: string): Promise<GeneratedVideo> {
    const source = await this.get(sourceSessionId, videoId);
    const video = { ...source, sessionId: targetSessionId, path: join(this.directory(targetSessionId), videoId + ".mp4") };
    await mkdir(dirname(video.path), { recursive: true, mode: 0o700 });
    await copyFile(source.path, video.path, constants.COPYFILE_EXCL);
    try { await this.manifest(video); } catch (error) { await unlink(video.path).catch(() => {}); throw error; }
    return video;
  }
  async inheritOnce(sourceSessionId: string, videoId: string, targetSessionId: string): Promise<GeneratedVideo> {
    const key = JSON.stringify([targetSessionId, videoId]); const pending = this.inheritance.get(key);
    if (pending) { await pending.catch(() => {}); return this.inheritOnce(sourceSessionId, videoId, targetSessionId); }
    const operation = (async () => {
      const source = await this.get(sourceSessionId, videoId); let existing: GeneratedVideo;
      try { existing = await this.get(targetSessionId, videoId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return this.inherit(sourceSessionId, videoId, targetSessionId); }
      const hash = async (file: string) => { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); };
      if (existing.sha256 !== source.sha256 || await hash(existing.path) !== await hash(source.path)) throw new Error("Inherited video conflicts with the existing session attachment.");
      return existing;
    })();
    this.inheritance.set(key, operation);
    try { return await operation; } finally { if (this.inheritance.get(key) === operation) this.inheritance.delete(key); }
  }
}
