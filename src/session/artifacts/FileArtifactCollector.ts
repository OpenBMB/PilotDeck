import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import type { PilotDeckToolResult } from "../../tool/index.js";
import type {
  FileArtifact,
  FileArtifactOperation,
  FileArtifactSource,
  FileArtifactStatus,
} from "./FileArtifact.js";

type FileFingerprint = {
  size: number;
  mtimeMs: number;
  sha256: string;
};

type ArtifactCandidate = {
  absolutePath: string;
  source: FileArtifactSource;
  fingerprint?: FileFingerprint;
};

export type FileArtifactCollectorOptions = {
  cwd: string;
  allowedInputPaths?: string[];
  now?: () => Date;
};

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".pilotdeck",
  ".cache",
  ".idea",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".temp",
  ".tmp",
  ".vscode",
  "build",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "qa",
  "screenshots",
  "target",
  "temp",
  "tmp",
]);

const INTERNAL_FILE_PATTERNS = [
  /^\.pilotdeck_build\.(?:c|m)?js$/i,
  /^\.DS_Store$/i,
  /\.(?:log|pid|sock)$/i,
  /\.(?:db|sqlite)(?:-(?:shm|wal))$/i,
];

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^(?:credentials?|secrets?|tokens?)(?:[-_.].*)?$/i,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/i,
  /\.(?:key|p12|pfx|pem)$/i,
];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".css": "text/css",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dps": "application/vnd.ms-powerpoint",
  ".et": "application/vnd.ms-excel",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".js": "text/javascript",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".wps": "application/vnd.ms-works",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

export class FileArtifactCollector {
  private readonly cwd: string;
  private readonly now: () => Date;
  private readonly baseline = new Map<string, FileFingerprint>();
  private readonly explicitCandidates = new Map<string, ArtifactCandidate>();
  private readonly allowedInputPaths: Set<string>;

  private constructor(options: FileArtifactCollectorOptions) {
    this.cwd = path.resolve(options.cwd);
    this.now = options.now ?? (() => new Date());
    this.allowedInputPaths = new Set(
      (options.allowedInputPaths ?? [])
        .map((inputPath) => path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(this.cwd, inputPath))
        .filter((inputPath) => isWithin(this.cwd, inputPath) && !isHardInternalPath(this.cwd, inputPath)),
    );
  }

  static async start(options: FileArtifactCollectorOptions): Promise<FileArtifactCollector> {
    const collector = new FileArtifactCollector(options);
    collector.baseline.clear();
    for (const file of await collector.scanWorkspace()) {
      collector.baseline.set(file.absolutePath, file.fingerprint);
    }
    await collector.captureAllowedInputFingerprints(collector.baseline);
    return collector;
  }

  observeToolResult(result: PilotDeckToolResult): void {
    if (result.type !== "success") return;

    for (const item of result.content) {
      if (item.type === "file") {
        this.addExplicitPath(item.path);
      }
    }

    if (["write_file", "edit_file", "edit_notebook"].includes(result.toolName)) {
      collectKnownFilePaths(result.data, (candidate) => this.addExplicitPath(candidate));
    }
  }

  async finish(status: FileArtifactStatus): Promise<FileArtifact[]> {
    const candidates = new Map<string, ArtifactCandidate>(this.explicitCandidates);
    for (const file of await this.scanWorkspace()) {
      const before = this.baseline.get(file.absolutePath);
      if (!before || before.sha256 !== file.fingerprint.sha256) {
        candidates.set(file.absolutePath, {
          absolutePath: file.absolutePath,
          source: candidates.get(file.absolutePath)?.source ?? "workspace_diff",
          fingerprint: file.fingerprint,
        });
      }
    }
    const allowedInputFinal = new Map<string, FileFingerprint>();
    await this.captureAllowedInputFingerprints(allowedInputFinal);
    for (const [absolutePath, fingerprint] of allowedInputFinal) {
      const before = this.baseline.get(absolutePath);
      if (!before || before.sha256 !== fingerprint.sha256) {
        candidates.set(absolutePath, {
          absolutePath,
          source: candidates.get(absolutePath)?.source ?? "workspace_diff",
          fingerprint,
        });
      }
    }

    const artifacts: FileArtifact[] = [];
    for (const candidate of candidates.values()) {
      const artifact = await this.materialize(candidate, status);
      if (artifact) artifacts.push(artifact);
    }

    return artifacts.sort((left, right) => left.path.localeCompare(right.path));
  }

  private addExplicitPath(candidate: string): void {
    const absolutePath = path.resolve(this.cwd, candidate);
    if (!isWithin(this.cwd, absolutePath) || !this.isAllowedArtifactPath(absolutePath)) return;
    this.explicitCandidates.set(absolutePath, { absolutePath, source: "tool" });
  }

  private async scanWorkspace(): Promise<Array<{ absolutePath: string; fingerprint: FileFingerprint }>> {
    const paths: string[] = [];
    await walk(this.cwd, async (absolutePath) => {
      if (!this.isAllowedArtifactPath(absolutePath)) return;
      paths.push(absolutePath);
    });
    const files: Array<{ absolutePath: string; fingerprint: FileFingerprint }> = [];
    for (let index = 0; index < paths.length; index += 8) {
      const batch = await Promise.all(
        paths.slice(index, index + 8).map(async (absolutePath) => {
          const fingerprint = await fingerprintFile(absolutePath).catch(() => undefined);
          return fingerprint ? { absolutePath, fingerprint } : undefined;
        }),
      );
      for (const file of batch) {
        if (file) files.push(file);
      }
    }
    return files;
  }

  private async captureAllowedInputFingerprints(target: Map<string, FileFingerprint>): Promise<void> {
    for (const absolutePath of this.allowedInputPaths) {
      const fingerprint = await fingerprintFile(absolutePath).catch(() => undefined);
      if (!fingerprint) continue;
      target.set(absolutePath, fingerprint);
    }
  }

  private async materialize(
    candidate: ArtifactCandidate,
    statusValue: FileArtifactStatus,
  ): Promise<FileArtifact | undefined> {
    if (!isWithin(this.cwd, candidate.absolutePath) || !this.isAllowedArtifactPath(candidate.absolutePath)) {
      return undefined;
    }
    const fingerprint = candidate.fingerprint
      ?? await fingerprintFile(candidate.absolutePath).catch(() => undefined);
    if (!fingerprint) return undefined;

    const relativePath = normalizeRelativePath(path.relative(this.cwd, candidate.absolutePath));
    if (!relativePath) return undefined;
    const before = this.baseline.get(candidate.absolutePath);
    if (before?.sha256 === fingerprint.sha256) {
      return undefined;
    }
    const operation: FileArtifactOperation = before ? "updated" : "created";

    return {
      id: createHash("sha256").update(`${relativePath}\0${fingerprint.sha256}`).digest("hex").slice(0, 24),
      name: path.basename(candidate.absolutePath),
      path: relativePath,
      operation,
      source: candidate.source,
      status: statusValue,
      size: fingerprint.size,
      sha256: fingerprint.sha256,
      ...(mimeTypeForPath(candidate.absolutePath) ? { mimeType: mimeTypeForPath(candidate.absolutePath) } : {}),
      createdAt: this.now().toISOString(),
    };
  }

  private isAllowedArtifactPath(absolutePath: string): boolean {
    if (isHardInternalPath(this.cwd, absolutePath)) return false;
    if (isSensitivePath(absolutePath)) return false;
    if (!isInternalPath(this.cwd, absolutePath)) return true;
    return this.allowedInputPaths.has(absolutePath);
  }
}

async function fingerprintFile(filePath: string): Promise<FileFingerprint | undefined> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return undefined;
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256: await sha256File(filePath),
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function walk(root: string, visit: (absolutePath: string) => Promise<void>): Promise<void> {
  const directory = await opendir(root).catch(() => undefined);
  if (!directory) return;
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
      await walk(absolutePath, visit);
      continue;
    }
    if (entry.isFile()) await visit(absolutePath);
  }
}

function isInternalPath(root: string, absolutePath: string): boolean {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!relativePath) return true;
  const segments = relativePath.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
    return true;
  }
  return INTERNAL_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(relativePath)));
}

function isSensitivePath(absolutePath: string): boolean {
  const basename = path.basename(absolutePath);
  if (/^\.env\.example$/i.test(basename)) return false;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

function isHardInternalPath(root: string, absolutePath: string): boolean {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!relativePath) return true;
  const segments = relativePath.split("/").map((segment) => segment.toLowerCase());
  return segments.some((segment) => segment === ".pilotdeck" || segment === ".git" || segment === "node_modules")
    || /^\.pilotdeck_build\.(?:c|m)?js$/i.test(path.basename(relativePath));
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function mimeTypeForPath(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function collectKnownFilePaths(value: unknown, add: (pathValue: string) => void, depth = 0): void {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectKnownFilePaths(item, add, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "string" &&
      /^(?:filePath|outputFile|outputPath|artifactPath)$/i.test(key)
    ) {
      add(child);
      continue;
    }
    collectKnownFilePaths(child, add, depth + 1);
  }
}
