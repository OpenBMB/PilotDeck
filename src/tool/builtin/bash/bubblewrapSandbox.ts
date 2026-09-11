import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  NodeShellCommandRunner,
  type PilotDeckCommandOptions,
  type PilotDeckCommandResult,
  type PilotDeckCommandRunner,
} from "./commandRunner.js";

export type BubblewrapSandboxCommandRunnerOptions = {
  /** Host workspace boundary. It is mounted at the same absolute path by default. */
  workspaceRoot: string;
  /** Omit the workspace bind and run in the sandbox-private `/tmp`. Defaults to true. */
  mountWorkspace?: boolean;
  /** Make the workspace mount read-only. Defaults to false. */
  readOnlyWorkspace?: boolean;
  /** Extra host paths mounted read-only at the same absolute path. */
  readOnlyPaths?: string[];
  /** The Bubblewrap executable. Defaults to `bwrap`. */
  executable?: string;
  /**
   * Environment visible to the sandboxed process. Host process variables are
   * deliberately not forwarded; `PATH` is supplied unless overridden here.
   */
  environment?: Record<string, string>;
  /**
   * Injectable only for adapters and tests. The default invokes Bubblewrap
   * through the normal managed shell runner.
   */
  delegate?: PilotDeckCommandRunner;
};

export type BubblewrapInvocation = {
  executable: string;
  args: string[];
};

const DEFAULT_RUNTIME_PATHS = ["/bin", "/usr", "/lib", "/lib64"];

/**
 * Runs Bash commands inside a Bubblewrap namespace.
 *
 * The sandbox has an empty root, a minimal read-only runtime, a private
 * `/tmp`, no network namespace, and an optional explicit workspace mount.
 * When the workspace is omitted, commands run from sandbox-private `/tmp`.
 * This is a Gateway-host primitive: callers must install Bubblewrap and opt
 * in through a host profile. It never falls back to unsandboxed execution.
 */
export class BubblewrapSandboxCommandRunner implements PilotDeckCommandRunner {
  private readonly workspaceRoot: string;
  private readonly delegate: PilotDeckCommandRunner;

  constructor(private readonly options: BubblewrapSandboxCommandRunnerOptions) {
    if (!options.workspaceRoot || !isAbsolute(options.workspaceRoot)) {
      throw new Error("Bubblewrap sandbox workspaceRoot must be an absolute path.");
    }
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.delegate = options.delegate ?? new NodeShellCommandRunner();
  }

  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    const invocation = this.buildInvocation(command, options.cwd, options.env);
    // Every argument, including the model-authored command, is quoted as one
    // shell word before handing it to the existing managed process runner.
    return this.delegate.run(toShellCommand(invocation), options);
  }

  buildInvocation(command: string, cwd: string, runtimeEnvironment?: NodeJS.ProcessEnv): BubblewrapInvocation {
    const resolvedCwd = resolve(cwd);
    if (!isWithin(this.workspaceRoot, resolvedCwd)) {
      throw new Error(
        `Bubblewrap sandbox cwd must be inside workspaceRoot: ${resolvedCwd}`,
      );
    }

    const mountWorkspace = this.options.mountWorkspace !== false;
    const executeCodeTempRoot = resolveExecuteCodeTempRoot(runtimeEnvironment);
    const readonlyPaths = uniqueExistingAbsolutePaths([
      ...DEFAULT_RUNTIME_PATHS,
      ...(this.options.readOnlyPaths ?? []),
    ]).filter((path) => path !== this.workspaceRoot);
    const targetDirectories = new Set<string>([
      ...(mountWorkspace ? parentDirectories(this.workspaceRoot) : []),
      ...(executeCodeTempRoot ? parentDirectories(executeCodeTempRoot) : []),
      ...readonlyPaths.flatMap(parentDirectories),
      "/tmp",
      "/proc",
      "/dev",
    ]);
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--unshare-net",
      "--clearenv",
      "--tmpfs",
      "/",
    ];
    for (const directory of [...targetDirectories].sort((left, right) => left.length - right.length)) {
      if (directory !== "/") args.push("--dir", directory);
    }
    for (const path of readonlyPaths) args.push("--ro-bind", path, path);
    if (mountWorkspace) {
      args.push(this.options.readOnlyWorkspace ? "--ro-bind" : "--bind", this.workspaceRoot, this.workspaceRoot);
    }
    if (executeCodeTempRoot) {
      // execute_code owns this fresh, private directory and removes it after
      // completion. Mounting only that directory lets the sandboxed Python
      // process reach its local UDS helper without exposing host `/tmp`.
      args.push("--bind", executeCodeTempRoot, executeCodeTempRoot);
    }
    args.push("--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev");
    for (const [name, value] of Object.entries({
      PATH: "/usr/bin:/bin",
      ...this.options.environment,
      ...sandboxRuntimeEnvironment(runtimeEnvironment),
    })) {
      args.push("--setenv", name, value);
    }
    args.push("--chdir", mountWorkspace ? resolvedCwd : "/tmp", "--", "/bin/sh", "-lc", command);
    return { executable: this.options.executable ?? "bwrap", args };
  }
}

function sandboxRuntimeEnvironment(environment: NodeJS.ProcessEnv | undefined): Record<string, string> {
  if (!environment) return {};
  const allowed = [
    "PILOTDECK_RPC_SOCKET",
    "PILOTDECK_EXECUTE_CODE_TEMP_ROOT",
    "PILOTDECK_WORKSPACE_CWD",
    "PYTHONPATH",
    "PYTHONDONTWRITEBYTECODE",
  ] as const;
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = environment[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function resolveExecuteCodeTempRoot(environment: NodeJS.ProcessEnv | undefined): string | undefined {
  const root = environment?.PILOTDECK_EXECUTE_CODE_TEMP_ROOT;
  const socket = environment?.PILOTDECK_RPC_SOCKET;
  if (!root || !socket || !isAbsolute(root) || !isAbsolute(socket)) return undefined;
  const resolvedRoot = resolve(root);
  const resolvedSocket = resolve(socket);
  if (!isWithin(resolve(tmpdir()), resolvedRoot) || !isWithin(resolvedRoot, resolvedSocket)) return undefined;
  return resolvedRoot;
}

export function toShellCommand(invocation: BubblewrapInvocation): string {
  return [invocation.executable, ...invocation.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function uniqueExistingAbsolutePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].filter((path) => isAbsolute(path) && existsSync(path));
}

function parentDirectories(path: string): string[] {
  const resolved = resolve(path);
  const parts = resolved.split(sep).filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `${sep}${part}`;
    result.push(current);
  }
  return result;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
