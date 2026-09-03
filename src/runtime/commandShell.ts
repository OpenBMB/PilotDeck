import { existsSync as defaultExistsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";

export type CommandShellKind = "bash" | "sh" | "cmd" | "pwsh" | "custom";

export type CommandShell = {
  shell: string;
  args: (command: string) => string[];
  kind: CommandShellKind;
  windowsVerbatimArguments: boolean;
};

export type CommandShellResolverOptions = {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  commandAvailable?: (command: string) => boolean;
};

const DEFAULT_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

const POSIX_BASH_NAMES = new Set(["bash", "bash.exe"]);
const POSIX_SH_NAMES = new Set(["sh", "sh.exe", "dash", "dash.exe", "ksh", "ksh.exe", "mksh", "mksh.exe"]);

/** Resolve the shell used for agent-authored foreground and background commands. */
export function resolveDefaultCommandShell(options: CommandShellResolverOptions = {}): CommandShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const commandAvailable = options.commandAvailable
    ?? ((command: string) => defaultCommandAvailable(command, platform, env, existsSync));

  const configured = env.PILOTDECK_SHELL_PATH;
  if (configured) {
    if (!commandAvailable(configured)) {
      throw new Error(`Configured PilotDeck shell was not found: ${configured}`);
    }
    return shellFromPath(configured);
  }

  if (platform !== "win32") {
    if (existsSync("/bin/bash")) return bashShell("/bin/bash");
    const bash = findOnPath("bash", env, platform, existsSync);
    if (bash) return bashShell(bash);
    return shellWithArgs("/bin/sh", "sh");
  }

  const gitBash = resolveWindowsGitBash(env, existsSync);
  if (gitBash) return bashShell(gitBash);

  const cmd = env.ComSpec || "cmd.exe";
  if (commandAvailable(cmd)) return shellWithArgs(cmd, "cmd");
  if (commandAvailable("pwsh.exe")) return shellWithArgs("pwsh.exe", "pwsh");

  throw new Error("No supported PilotDeck command shell found. Install Git Bash, cmd.exe, or PowerShell 7 (pwsh.exe).");
}

export function resolveWindowsGitBash(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = defaultExistsSync,
): string | undefined {
  const candidates = [
    env.PILOTDECK_GIT_BASH_PATH,
    env.GIT_BASH_PATH,
    ...(env.ProgramFiles ? [
      `${env.ProgramFiles}\\Git\\bin\\bash.exe`,
      `${env.ProgramFiles}\\Git\\usr\\bin\\bash.exe`,
    ] : []),
    ...(env["ProgramFiles(x86)"] ? [
      `${env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`,
      `${env["ProgramFiles(x86)"]}\\Git\\usr\\bin\\bash.exe`,
    ] : []),
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`] : []),
    ...DEFAULT_GIT_BASH_PATHS,
  ].filter((candidate): candidate is string => Boolean(candidate));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

function shellFromPath(shell: string): CommandShell {
  const name = shell.split(/[\\/]/u).at(-1)?.toLowerCase() ?? shell.toLowerCase();
  if (POSIX_BASH_NAMES.has(name)) return bashShell(shell);
  if (POSIX_SH_NAMES.has(name)) return shellWithArgs(shell, "sh");
  if (name === "cmd" || name === "cmd.exe") return shellWithArgs(shell, "cmd");
  if (name === "pwsh" || name === "pwsh.exe") return shellWithArgs(shell, "pwsh");
  return shellWithArgs(shell, "custom");
}

function bashShell(shell: string): CommandShell {
  return shellWithArgs(shell, "bash");
}

function shellWithArgs(shell: string, kind: CommandShellKind): CommandShell {
  if (kind === "cmd") {
    return {
      shell,
      kind,
      args: (command) => ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (kind === "pwsh") {
    return {
      shell,
      kind,
      args: (command) => ["-NoLogo", "-NoProfile", "-Command", command],
      windowsVerbatimArguments: false,
    };
  }
  return { shell, kind, args: (command) => ["-c", command], windowsVerbatimArguments: false };
}

function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  existsSync: (path: string) => boolean,
): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const pathValue = pathKey ? env[pathKey] : undefined;
  if (!pathValue) return undefined;
  for (const entry of pathValue.split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
    const candidate = platform === "win32" ? win32.join(entry, command) : join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function defaultCommandAvailable(
  command: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  if (platform === "win32" && command.toLowerCase() === "cmd.exe" && !Object.keys(env).some((key) => key.toLowerCase() === "path")) {
    return true;
  }
  return Boolean(findOnPath(command, env, platform, existsSync));
}
