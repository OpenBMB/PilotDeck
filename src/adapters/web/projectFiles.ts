/**
 * Workspace-safe project file service.
 *
 * Used by `src/adapters/web/httpRouter.ts` to back the `/api/web/projects/*`
 * file endpoints. Every public method:
 *   - resolves the requested path against `projectRoot`
 *   - rejects paths that escape `projectRoot` (via `..` or absolute leak)
 *   - rejects symlinks that point outside `projectRoot`
 *
 * The service is intentionally narrow — full Phase 4 support (rename, upload,
 * binary metadata) is layered on top of these primitives.
 */

import {
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

export type WebFileEntry = {
  name: string;
  /** Path relative to the project root (POSIX-style). */
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt?: string;
};

export type WebFileTreeResult = {
  projectKey: string;
  entries: WebFileEntry[];
};

export type WebFileReadResult = {
  projectKey: string;
  path: string;
  size: number;
  encoding: "utf8" | "base64";
  content?: string;
  binary?: boolean;
  mimeHint?: string;
};

export type ProjectFileServiceOptions = {
  projectRoot: string;
  /** Maximum bytes returned by readFile; larger files return metadata only. */
  maxReadBytes?: number;
};

const DEFAULT_MAX_READ_BYTES = 1024 * 1024; // 1 MiB

const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "mdx",
  "yml",
  "yaml",
  "txt",
  "css",
  "html",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "sh",
  "bash",
  "toml",
  "ini",
  "csv",
  "tsv",
  "env",
  "lock",
]);

export class WorkspaceBoundaryError extends Error {
  constructor(public readonly path: string) {
    super(`Path escapes workspace root: ${path}`);
    this.name = "WorkspaceBoundaryError";
  }
}

export class ProjectFileService {
  private readonly projectRoot: string;
  private readonly maxReadBytes: number;

  constructor(private readonly options: ProjectFileServiceOptions) {
    // Resolve symlinks once so subsequent `realpath` checks compare against
    // the same canonical form (e.g. macOS /var → /private/var).
    const resolved = resolve(options.projectRoot);
    let canonical = resolved;
    try {
      canonical = realpathSync(resolved);
    } catch {
      // Path may not exist yet (writes to a fresh dir); fall back to the
      // lexical resolve.
    }
    this.projectRoot = canonical;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  async readTree(relativePath = "."): Promise<WebFileTreeResult> {
    const target = await this.resolveSafe(relativePath);
    const stats = await stat(target);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${relativePath}`);
    }
    const dir = await readdir(target, { withFileTypes: true });
    const entries: WebFileEntry[] = [];
    for (const dirent of dir) {
      const childPath = resolve(target, dirent.name);
      let type: WebFileEntry["type"] = "other";
      if (dirent.isDirectory()) type = "directory";
      else if (dirent.isFile()) type = "file";
      else if (dirent.isSymbolicLink()) type = "symlink";
      let size: number | undefined;
      let modifiedAt: string | undefined;
      try {
        const childStats = await stat(childPath);
        size = childStats.size;
        modifiedAt = childStats.mtime.toISOString();
      } catch {
        // ignore
      }
      entries.push({
        name: dirent.name,
        path: this.toRelative(childPath),
        type,
        size,
        modifiedAt,
      });
    }
    entries.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (b.type === "directory" && a.type !== "directory") return 1;
      return a.name.localeCompare(b.name);
    });
    return { projectKey: this.projectRoot, entries };
  }

  async readFile(relativePath: string): Promise<WebFileReadResult> {
    const target = await this.resolveSafe(relativePath);
    const stats = await stat(target);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${relativePath}`);
    }
    const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
    const isText = TEXT_EXTENSIONS.has(ext);

    if (stats.size > this.maxReadBytes) {
      return {
        projectKey: this.projectRoot,
        path: this.toRelative(target),
        size: stats.size,
        encoding: isText ? "utf8" : "base64",
        binary: !isText,
      };
    }

    if (isText) {
      const content = await readFile(target, "utf8");
      return {
        projectKey: this.projectRoot,
        path: this.toRelative(target),
        size: stats.size,
        encoding: "utf8",
        content,
      };
    }

    const buffer = await readFile(target);
    return {
      projectKey: this.projectRoot,
      path: this.toRelative(target),
      size: stats.size,
      encoding: "base64",
      content: buffer.toString("base64"),
      binary: true,
    };
  }

  async writeFile(relativePath: string, content: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    const target = await this.resolveSafeWriting(relativePath);
    await mkdir(dirname(target), { recursive: true });
    if (encoding === "base64") {
      await writeFile(target, Buffer.from(content, "base64"));
    } else {
      await writeFile(target, content, "utf8");
    }
  }

  /**
   * Resolve a relative path against the project root and ensure the
   * resolved (and realpath-resolved) target stays within it. Throws
   * `WorkspaceBoundaryError` for escapes.
   */
  async resolveSafe(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    const normalized = normalize(relativePath);
    if (normalized.startsWith("..")) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    const target = resolve(this.projectRoot, normalized);
    if (!this.isInsideRoot(target)) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    // Resolve symlinks if the target exists; if it doesn't (e.g. write
    // before create) fall back to the lexical check above.
    try {
      const real = await realpath(target);
      if (!this.isInsideRoot(real)) {
        throw new WorkspaceBoundaryError(relativePath);
      }
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return target;
      }
      throw error;
    }
  }

  /** Same as resolveSafe but tolerates non-existent paths (for writes). */
  async resolveSafeWriting(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    const normalized = normalize(relativePath);
    if (normalized.startsWith("..")) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    const target = resolve(this.projectRoot, normalized);
    if (!this.isInsideRoot(target)) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    return target;
  }

  private isInsideRoot(absolutePath: string): boolean {
    const rel = relative(this.projectRoot, absolutePath);
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  private toRelative(absolutePath: string): string {
    const rel = relative(this.projectRoot, absolutePath);
    return rel === "" ? "." : rel.split(/[\\/]/).join("/");
  }
}
