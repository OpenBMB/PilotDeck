import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
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
        await pruneIgnored(target, ignores).catch(() => undefined);
        return "clonefile";
      }
    } else if (platform() === "linux") {
      const ok = await tryReflinkCopy(source, target);
      if (ok) {
        await pruneIgnored(target, ignores).catch(() => undefined);
        return "reflink";
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
  if (filePath === root) return false;
  const rel = filePath.startsWith(root) ? filePath.slice(root.length).replace(/^[/\\]+/, "") : filePath;
  if (rel.length === 0) return false;
  const head = rel.split(/[/\\]/)[0];
  if (ignores.has(head)) return true;
  return false;
}

async function pruneIgnored(target: string, ignores: Set<string>): Promise<void> {
  for (const entry of ignores) {
    await rm(resolve(target, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function estimateSize(root: string, ignores: Set<string>): Promise<number> {
  // Quick best-effort estimate; if the OS command fails fall back to 0
  // (caller still copies but skips the cap).
  if (platform() === "win32") {
    return estimateSizeWindows(root, ignores);
  }
  return runCommand("du", ["-sk", root])
    .then((result) => {
      if (result.exitCode !== 0) return 0;
      const tokens = result.stdout.trim().split(/\s+/);
      const kb = Number.parseInt(tokens[0], 10);
      return Number.isFinite(kb) ? kb * 1024 : 0;
    })
    .catch(() => 0);
}

async function estimateSizeWindows(root: string, _ignores: Set<string>): Promise<number> {
  const script = `(Get-ChildItem -Path '${root.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`;
  return runCommand("powershell", ["-NoProfile", "-Command", script])
    .then((result) => {
      if (result.exitCode !== 0) return 0;
      const bytes = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(bytes) ? bytes : 0;
    })
    .catch(() => 0);
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
