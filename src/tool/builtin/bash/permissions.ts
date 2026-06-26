import {
  DEFAULT_SUDO_PERMISSION_POLICY,
  normalizeSudoPermissionPolicy,
  type PermissionResult,
  type SudoPermissionPolicy,
} from "../../../permission/index.js";

const COMMAND_POSITION = String.raw`(?:^|[;&|]\s*)`;
const SHELL_SEGMENT = String.raw`[^;&|\n]*`;
const RM_RECURSIVE_LOOKAHEAD = String.raw`(?=${SHELL_SEGMENT}(?:-[^\s;&|]*r|--recursive\b))`;
const OPTIONAL_SHELL_QUOTE = String.raw`["']?`;
const ROOT_DELETE_TARGET = String.raw`${OPTIONAL_SHELL_QUOTE}(?:/|/\*|/ \*|//+|/\.)${OPTIONAL_SHELL_QUOTE}`;
const SYSTEM_DELETE_TARGET = String.raw`${OPTIONAL_SHELL_QUOTE}/(?:bin|boot|etc|home|lib|lib64|root|sbin|usr|var)(?:/|${OPTIONAL_SHELL_QUOTE}(?:\s|$))`;
const HOME_DELETE_TARGET = String.raw`${OPTIONAL_SHELL_QUOTE}(?:~|\$HOME|\$\{HOME\})(?:/|${OPTIONAL_SHELL_QUOTE}(?:\s|$))`;
const ROOT_DELETE_TARGET_LOOKAHEAD = String.raw`(?=${SHELL_SEGMENT}\s${ROOT_DELETE_TARGET}(?:\s|$))`;
const SYSTEM_DELETE_TARGET_LOOKAHEAD = String.raw`(?=${SHELL_SEGMENT}\s${SYSTEM_DELETE_TARGET})`;
const HOME_DELETE_TARGET_LOOKAHEAD = String.raw`(?=${SHELL_SEGMENT}\s${HOME_DELETE_TARGET})`;

const HARD_DENY_PATTERNS: RegExp[] = [
  // Unix — catastrophic filesystem destruction.
  commandPattern(String.raw`rm\s+${RM_RECURSIVE_LOOKAHEAD}${ROOT_DELETE_TARGET_LOOKAHEAD}`),
  commandPattern(String.raw`rm\s+${RM_RECURSIVE_LOOKAHEAD}${SYSTEM_DELETE_TARGET_LOOKAHEAD}`),
  commandPattern(String.raw`rm\s+${RM_RECURSIVE_LOOKAHEAD}${HOME_DELETE_TARGET_LOOKAHEAD}`),
  commandPattern(String.raw`mkfs(?:\.[a-z0-9]+)?\b`),
  commandPattern(String.raw`dd\b${SHELL_SEGMENT}\bof=/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`),
  />\s*\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/i,

  // Unix — host shutdown / denial of service.
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  commandPattern(String.raw`kill\s+(-[^\s]+\s+)*-1\b`),
  commandPattern(String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?(?:shutdown|reboot|halt|poweroff)\b`),
  commandPattern(String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?init\s+[06]\b`),
  commandPattern(String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?systemctl\s+(?:poweroff|reboot|halt|kexec)\b`),
  commandPattern(String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?telinit\s+[06]\b`),

  // Unix — password guessing / stdin privilege escalation.
  commandPattern(String.raw`sudo\b${SHELL_SEGMENT}(?:\s--stdin\b|\s-[A-Za-z]*S[A-Za-z]*\b)`, ""),

  // Windows — filesystem formatting.
  /\bFormat-Volume\b/i,
];

const DANGEROUS_ASK_PATTERNS: RegExp[] = [
  // Unix
  commandPattern(String.raw`rm\s+${RM_RECURSIVE_LOOKAHEAD}`),
  commandPattern(String.raw`sudo\b`),
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\b/,
  /\bdd\s+if=/,
  /\b(curl|wget)\b[^|;&]*\|\s*(?:\/?[\w.-]+\/)*(?:ba)?sh(?:\s|$|-c)/i,

  // Cross-platform
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[^\s]*f/,

  // Windows — PowerShell recursive delete (Remove-Item -Recurse -Force)
  /\bRemove-Item\b[^|;&]*-Recurse\b/i,
  // Windows — CMD recursive delete
  /\bdel\s+\/[^\s]*s\b/i,
  /\brd\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  // Windows — download-and-execute (iex(iwr ...) / Invoke-Expression(Invoke-WebRequest ...))
  /\biex\s*\(\s*iwr\b/i,
  /\bInvoke-Expression\b[^|;&]*\bInvoke-WebRequest\b/i,
  // Windows — privilege escalation via Start-Process -Verb RunAs
  /\bStart-Process\b[^|;&]*-Verb\s+RunAs\b/i,
  // Windows — weaken execution policy
  /\bSet-ExecutionPolicy\s+(Unrestricted|Bypass)\b/i,
  // Windows — stop arbitrary processes
  /\bStop-Process\b[^|;&]*-Force\b/i,
];

const SIMPLE_READ_COMMANDS = new Set([
  "cat",
  "date",
  "echo",
  "head",
  "ls",
  "printf",
  "pwd",
  "wc",
  "whoami",
]);

const WINDOWS_READ_COMMANDS = new Set([
  "dir",
  "findstr",
  "get-childitem",
  "get-command",
  "get-content",
  "get-date",
  "get-item",
  "get-itemproperty",
  "get-location",
  "get-process",
  "resolve-path",
  "select-string",
  "test-path",
  "type",
  "where",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["diff", "log", "show", "status"]);

export function classifyBashPermission(
  command: string,
  sudoPolicy: SudoPermissionPolicy = DEFAULT_SUDO_PERMISSION_POLICY,
): PermissionResult {
  if (HARD_DENY_PATTERNS.some((pattern) => pattern.test(command))) {
    return {
      type: "deny",
      reason: { type: "safety", message: "Dangerous shell command denied." },
      message: "Dangerous shell command denied.",
    };
  }

  const sudoDecision = decideSudoPermission(command, sudoPolicy);
  if (sudoDecision) {
    return sudoDecision;
  }

  if (DANGEROUS_ASK_PATTERNS.some((pattern) => pattern.test(command))) {
    return askForShellPermission(command);
  }

  if (isReadOnlyShellCommand(command)) {
    return { type: "passthrough" };
  }

  return askForShellPermission(command);
}

export function decideSudoPermission(
  command: string,
  sudoPolicy: SudoPermissionPolicy = DEFAULT_SUDO_PERMISSION_POLICY,
): PermissionResult | undefined {
  if (!/\bsudo\b/.test(command)) {
    return undefined;
  }

  const policy = normalizeSudoPermissionPolicy(sudoPolicy);
  const matches = findSudoMatches(command, policy);
  const match = matches.find((entry) => entry.action === "deny")
    ?? matches.find((entry) => entry.action === "ask")
    ?? matches[0];
  if (!match) {
    return {
      type: "deny",
      reason: { type: "safety", message: "sudo command could not be classified by sudo policy." },
      message: "sudo command could not be classified by sudo policy.",
    };
  }

  if (match.action === "allow") {
    if (hasNonSudoShellSegments(command)) {
      return undefined;
    }
    const location = match.scope === "remote" ? `remote host ${match.host}` : "the local machine";
    return {
      type: "allow",
      reason: {
        type: "tool",
        toolName: "bash",
        message: `sudo command on ${location} is allowed by sudo policy.`,
      },
    };
  }

  const location = match.scope === "remote" ? `remote host ${match.host}` : "the local machine";
  const message = `sudo command on ${location} is ${match.action === "deny" ? "denied" : "waiting for permission"} by sudo policy.`;

  if (match.action === "deny") {
    return {
      type: "deny",
      reason: { type: "safety", message },
      message,
    };
  }

  return {
    type: "ask",
    reason: { type: "tool", toolName: "bash", message },
    request: {
      toolCallId: "",
      toolName: "bash",
      inputSummary: command,
      reason: { type: "tool", toolName: "bash", message },
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "deny", label: "Deny" },
        { id: "cancel", label: "Cancel" },
      ],
      metadata: {
        sudo: {
          scope: match.scope,
          host: match.host,
          action: match.action,
        },
      },
    },
  };
}

function hasNonSudoShellSegments(command: string): boolean {
  return splitShellSegments(command).some((segment) => !/\bsudo\b/.test(segment));
}

type SudoMatch = {
  scope: "local" | "remote";
  host?: string;
  action: "deny" | "ask" | "allow";
};

function findSudoMatches(command: string, policy: SudoPermissionPolicy): SudoMatch[] {
  const segments = splitShellSegments(command).filter((segment) => /\bsudo\b/.test(segment));
  const targets = segments.length > 0 ? segments : [command];
  return targets.map((segment) => {
    const remote = detectRemoteSudo(segment);
    if (!remote) {
      return { scope: "local", action: policy.local };
    }
    return {
      scope: "remote",
      host: remote.host,
      action: policy.remoteHosts.find((entry) => matchesRemoteHost(entry.host, remote.host))?.action ?? policy.remote,
    };
  });
}

function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = () => {
    if (current.trim()) out.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";" || char === "|") {
      push();
      if (char === "|" && next === "|") index += 1;
      continue;
    }
    if (char === "&" && next === "&") {
      push();
      index += 1;
      continue;
    }
    current += char;
  }
  push();
  return out;
}

function detectRemoteSudo(segment: string): { host: string } | undefined {
  const firstSudoIndex = segment.search(/\bsudo\b/);
  const firstSshIndex = findFirstSshExecutableIndex(segment);
  if (firstSudoIndex < 0 || firstSshIndex < 0 || firstSudoIndex < firstSshIndex) {
    return undefined;
  }

  const tokens = tokenizeSimpleShell(segment);
  if (tokens && tokens.length > 0) {
    const sshIndex = tokens.findIndex((token) => normalizeExecutableName(baseExecutableName(token)) === "ssh");
    if (sshIndex < 0) return undefined;
    const hostInfo = parseSshHost(tokens, sshIndex + 1);
    if (!hostInfo) return undefined;
    const remoteCommand = tokens.slice(hostInfo.nextIndex).join(" ");
    return /\bsudo\b/.test(remoteCommand) ? { host: hostInfo.host } : undefined;
  }

  const match = /(?:^|\s)(?:\S*[\\/])?ssh(?:\.(?:exe|cmd|bat))?\s+(?<args>[\s\S]*)/i.exec(segment);
  const args = match?.groups?.args;
  if (!args) return undefined;
  const host = parseSshHostFromText(args);
  if (!host) return undefined;
  const hostIndex = segment.indexOf(host, match.index);
  return hostIndex >= 0 && segment.slice(hostIndex + host.length).search(/\bsudo\b/) >= 0
    ? { host }
    : undefined;
}

function findFirstSshExecutableIndex(command: string): number {
  const match = /(?:^|\s)(?:\S*[\\/])?ssh(?:\.(?:exe|cmd|bat))?(?:\s|$)/i.exec(command);
  if (!match) return -1;
  return match.index + (match[0].startsWith(" ") ? 1 : 0);
}

const SSH_OPTIONS_WITH_VALUE = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

function parseSshHost(tokens: string[], startIndex: number): { host: string; nextIndex: number } | undefined {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      const host = tokens[index + 1];
      return host ? { host: normalizeSshHost(host), nextIndex: index + 2 } : undefined;
    }
    if (SSH_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return { host: normalizeSshHost(token), nextIndex: index + 1 };
  }
  return undefined;
}

function parseSshHostFromText(args: string): string | undefined {
  const tokens = args.trim().split(/\s+/);
  return parseSshHost(tokens, 0)?.host;
}

function normalizeSshHost(host: string): string {
  return host.replace(/^ssh:\/\//i, "").replace(/\/$/, "");
}

function baseExecutableName(commandName: string): string {
  return commandName.split(/[\\/]/).pop() ?? commandName;
}

function matchesRemoteHost(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedPattern) return false;
  if (normalizedPattern === normalizedHost) return true;
  const hostWithoutUser = normalizedHost.includes("@")
    ? normalizedHost.slice(normalizedHost.lastIndexOf("@") + 1)
    : normalizedHost;
  if (normalizedPattern === hostWithoutUser) return true;
  const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*/g, ".*")}$`, "i");
  return regex.test(normalizedHost) || regex.test(hostWithoutUser);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function askForShellPermission(command: string): PermissionResult {
  return {
    type: "ask",
    reason: { type: "tool", toolName: "bash", message: "Shell command may have side effects." },
    request: {
      toolCallId: "",
      toolName: "bash",
      inputSummary: command,
      reason: { type: "tool", toolName: "bash", message: "Shell command may have side effects." },
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "deny", label: "Deny" },
        { id: "cancel", label: "Cancel" },
      ],
    },
  };
}

function commandPattern(pattern: string, flags = "i"): RegExp {
  return new RegExp(`${COMMAND_POSITION}${pattern}`, flags);
}

export function isReadOnlyShellCommand(command: string): boolean {
  const tokens = tokenizeSimpleShell(command);
  if (!tokens || tokens.length === 0) {
    return false;
  }

  const [commandName, ...args] = tokens;
  const normalizedCommandName = normalizeExecutableName(commandName);
  if (SIMPLE_READ_COMMANDS.has(normalizedCommandName) || WINDOWS_READ_COMMANDS.has(normalizedCommandName)) {
    return true;
  }

  if (normalizedCommandName === "git") {
    const subcommand = getGitSubcommand(args);
    return (
      subcommand !== undefined
      && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)
      && !args.some((arg) => arg === "--output" || arg.startsWith("--output="))
    );
  }

  if (isPowerShellCommand(normalizedCommandName)) {
    return isReadOnlyPowerShellInvocation(args);
  }

  if (normalizedCommandName === "find") {
    return isReadOnlyFindTokens(args);
  }

  return normalizedCommandName === "sh" && args.length === 2 && args[0] === "-c" && /^exit\s+\d+$/.test(args[1]);
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--namespace",
  "--super-prefix",
]);

const GIT_GLOBAL_OPTIONS_WITH_VALUE_PREFIXES = [
  "--namespace=",
  "--super-prefix=",
];

const GIT_UNSAFE_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--work-tree",
]);
const GIT_UNSAFE_GLOBAL_OPTIONS_WITH_VALUE_PREFIXES = [
  "-C",
  "-c",
  "--config-env=",
  "--exec-path=",
  "--git-dir=",
  "--work-tree=",
];

function getGitSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      return undefined;
    }
    if (
      GIT_UNSAFE_GLOBAL_OPTIONS_WITH_VALUE.has(arg)
      || GIT_UNSAFE_GLOBAL_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))
    ) {
      return undefined;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg.toLowerCase();
  }
  return undefined;
}

function isPowerShellCommand(commandName: string): boolean {
  return commandName === "powershell" || commandName === "pwsh";
}

function isReadOnlyPowerShellInvocation(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const normalized = arg.toLowerCase();
    if (normalized === "-noprofile" || normalized === "-noninteractive" || normalized === "-nologo") {
      continue;
    }
    if (normalized === "-command" || normalized === "-c") {
      return isReadOnlyPowerShellCommand(args.slice(index + 1));
    }
    if (normalized.startsWith("-command:")) {
      return isReadOnlyPowerShellCommand([arg.slice("-command:".length)]);
    }
    return false;
  }
  return false;
}

function isReadOnlyPowerShellCommand(commandTokens: string[]): boolean {
  if (commandTokens.length === 0) {
    return false;
  }
  const commandText = commandTokens.join(" ");
  if (/[{}|;&<>`]/.test(commandText) || /\$\s*\(/.test(commandText)) {
    return false;
  }
  const tokens = tokenizeSimpleShell(commandText);
  if (!tokens || tokens.length === 0) {
    return false;
  }
  const commandName = normalizeExecutableName(tokens[0]!);
  return SIMPLE_READ_COMMANDS.has(commandName) || WINDOWS_READ_COMMANDS.has(commandName);
}

function normalizeExecutableName(commandName: string): string {
  return commandName.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

const FIND_MUTATING_OR_EXEC_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

function isReadOnlyFindTokens(args: string[]): boolean {
  return !args.some((token) => FIND_MUTATING_OR_EXEC_ACTIONS.has(token));
}

function tokenizeSimpleShell(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && (char === "`" || (char === "$" && next === "("))) {
        return undefined;
      }
      if (char === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if ("|;&<>`".includes(char) || (char === "$" && next === "(")) {
      return undefined;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return undefined;
  }
  pushCurrent();
  return tokens;
}
