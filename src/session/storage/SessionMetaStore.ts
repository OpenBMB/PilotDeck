import { writeFile, rename, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { sanitizeSessionIdForPath } from "./ProjectSessionStorage.js";

export type ForkedFromInfo = {
  sessionId: string;
  entryId: string | null;
  forkedAt: string;
};

export type SessionMeta = {
  forkedFrom?: ForkedFromInfo;
  customTitle?: string;
};

export type SessionMetaStoreOptions = {
  chatDir: string;
  sessionId: string; // raw (un-sanitized) sessionId
};

export class SessionMetaStore {
  readonly metaPath: string;
  private readonly safeId: string;

  constructor(opts: SessionMetaStoreOptions) {
    this.safeId = sanitizeSessionIdForPath(opts.sessionId);
    this.metaPath = resolve(opts.chatDir, `${this.safeId}.meta.json`);
  }

  async load(): Promise<SessionMeta | null> {
    try {
      const raw = await readFile(this.metaPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: SessionMeta = {};
      const obj = parsed as Record<string, unknown>;
      if (obj.customTitle && typeof obj.customTitle === "string") {
        out.customTitle = obj.customTitle;
      }
      if (obj.forkedFrom && typeof obj.forkedFrom === "object" && !Array.isArray(obj.forkedFrom)) {
        const ff = obj.forkedFrom as Record<string, unknown>;
        if (typeof ff.sessionId === "string" && (ff.entryId === null || typeof ff.entryId === "string") && typeof ff.forkedAt === "string") {
          out.forkedFrom = {
            sessionId: ff.sessionId,
            entryId: typeof ff.entryId === "string" ? ff.entryId : null,
            forkedAt: ff.forkedAt,
          };
        }
      }
      return out;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return null;
      // Corrupt JSON: treat as no meta. Don't crash listers.
      return null;
    }
  }

  async save(meta: SessionMeta): Promise<void> {
    const tmp = `${this.metaPath}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await rename(tmp, this.metaPath);
  }

  async remove(): Promise<void> {
    try {
      await unlink(this.metaPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") throw err;
    }
  }
}
