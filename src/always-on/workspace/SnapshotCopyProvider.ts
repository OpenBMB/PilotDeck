import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { AlwaysOnError } from "../protocol/errors.js";
import type { WorkspaceHandle } from "../protocol/types.js";
import type { WorkspaceProvider, WorkspacePrepareInput, WorkspacePublishOutput } from "./WorkspaceProvider.js";

export type SnapshotCopyProviderOptions = {
  baseDir: string;
  /** Hard cap on source size in bytes. Default 1 GiB. */
  maxBytes: number;
  /** Defaults: `.git/`, `node_modules/`, `dist/`, `.pilotdeck/`, `.pilotdeck-always-on/`. */
  ignorePaths?: string[];
};

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  ".pilotdeck",
  ".pilotdeck-always-on",
];

export class SnapshotCopyProvider implements WorkspaceProvider {
  readonly id = "snapshot-copy" as const;
  readonly priority = 2;

  constructor(private readonly options: SnapshotCopyProviderOptions) {}

  async isApplicable(projectRoot: string): Promise<boolean> {
    try {
      const info = await stat(projectRoot);
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  async prepare(input: WorkspacePrepareInput): Promise<WorkspaceHandle> {
    const target = resolve(this.options.baseDir, input.runId);

    const sizeBytes = await estimateSize(input.projectRoot, this.ignoreSet());
    if (sizeBytes > this.options.maxBytes) {
      throw new AlwaysOnError(
        "workspace_prepare_failed",
        `snapshot source size ${sizeBytes} exceeds maxBytes ${this.options.maxBytes}.`,
      );
    }

    await mkdir(resolve(target, ".."), { recursive: true });
    const strategy = await this.copy(input.projectRoot, target);

    return {
      runId: input.runId,
      projectKey: input.projectRoot,
      strategy: this.id,
      cwd: target,
      metadata: {
        copyStrategy: strategy,
        baseSize: String(sizeBytes),
      },
    };
  }

  async publish(handle: WorkspaceHandle): Promise<WorkspacePublishOutput> {
    return { diff: `snapshot at ${handle.cwd}` };
  }

  async dispose(handle: WorkspaceHandle, options: { keep: boolean }): Promise<void> {
    if (options.keep) return;
    await rm(handle.cwd, { recursive: true, force: true });
  }

  private ignoreSet(): Set<string> {
    return new Set(this.options.ignorePaths ?? DEFAULT_IGNORES);
  }

  private async copy(source: string, target: string): Promise<string> {
    const ignores = this.ignoreSet();
    if (platform() === "darwin") {
      const ok = await tryClonefile(source, target);
      if (ok) {
        if (await tryPruneSnapshot(target, ignores)) {
          return "clonefile";
        }
      }
    } else if (platform() === "linux") {
      const ok = await tryReflinkCopy(source, target);
      if (ok) {
        if (await tryPruneSnapshot(target, ignores)) {
          return "reflink";
        }
      }
    }
    await cp(source, target, {
      recursive: true,
      filter: (src) => !isIgnored(src, source, ignores),
      errorOnExist: false,
    });
    return "fs.cp";
  }
}

async function tryClonefile(source: string, target: string): Promise<boolean> {
  // `cp -c` triggers macOS clonefile when source/target live on the same APFS volume.
  return runCommand("cp", ["-c", "-R", source, target])
    .then((result) => result.exitCode === 0 && existsSync(target))
    .catch(() => false);
}

async function tryReflinkCopy(source: string, target: string): Promise<boolean> {
  return runCommand("cp", ["--reflink=auto", "-R", source, target])
    .then((result) => result.exitCode === 0 && existsSync(target))
    .catch(() => false);
}

function isIgnored(filePath: string, root: string, ignores: Set<string>): boolean {
  return relativePathSegments(filePath, root).some((segment) => ignores.has(segment));
}

async function pruneIgnored(target: string, ignores: Set<string>): Promise<void> {
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(target, entry.name);
    if (ignores.has(entry.name)) {
      await rm(entryPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await pruneIgnored(entryPath, ignores);
    }
  }
}

async function tryPruneSnapshot(target: string, ignores: Set<string>): Promise<boolean> {
  try {
    await pruneIgnored(target, ignores);
    return true;
  } catch {
    await rm(target, { recursive: true, force: true });
    return false;
  }
}

async function estimateSize(root: string, ignores: Set<string>): Promise<number> {
  return estimateSizeWalk(root, root, ignores).catch(() => 0);
}

async function estimateSizeWalk(filePath: string, root: string, ignores: Set<string>): Promise<number> {
  if (isIgnored(filePath, root, ignores)) {
    return 0;
  }

  const info = await lstat(filePath).catch(() => undefined);
  if (!info) {
    return 0;
  }
  if (!info.isDirectory()) {
    return info.size;
  }

  const entries = await readdir(filePath, { withFileTypes: true }).catch(() => []);
  let total = info.size;
  for (const entry of entries) {
    total += await estimateSizeWalk(resolve(filePath, entry.name), root, ignores);
  }
  return total;
}

function relativePathSegments(filePath: string, root: string): string[] {
  const rel = relative(root, filePath);
  if (!rel || isAbsolute(rel)) {
    return [];
  }
  const segments = rel.split(/[/\\]/).filter(Boolean);
  return segments[0] === ".." ? [] : segments;
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runCommand(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolvePromise({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
