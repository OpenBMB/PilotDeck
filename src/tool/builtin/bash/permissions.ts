import type { PermissionResult } from "../../../permission/index.js";

const DENY_PATTERNS: RegExp[] = [
  // Unix
  /\brm\s+-[^&|;]*r[^&|;]*f\s+\//,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\b/,
  /\bdd\s+if=/,
  /\b(curl|wget)\b[^|;&]*\|\s*(sh|bash)\b/,

  // Cross-platform
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[^\s]*f/,

  // Windows — PowerShell recursive delete (Remove-Item -Recurse -Force)
  /\bRemove-Item\b[^|;&]*-Recurse\b/i,
  // Windows — CMD recursive delete
  /\bdel\s+\/[^\s]*s\b/i,
  /\brd\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  // Windows — Format disk volume
  /\bFormat-Volume\b/i,
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

export function classifyBashPermission(command: string): PermissionResult {
  if (DENY_PATTERNS.some((pattern) => pattern.test(command))) {
    return {
      type: "deny",
      reason: { type: "safety", message: "Dangerous shell command denied." },
      message: "Dangerous shell command denied.",
    };
  }

  if (isReadOnlyShellCommand(command)) {
    return { type: "passthrough" };
  }

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

export function isReadOnlyShellCommand(command: string): boolean {
  if (hasShellControlOperator(command) || hasWriteCapableNodeEval(command)) {
    return false;
  }

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

function hasShellControlOperator(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (char === "\\" && quote === '"') {
        escaped = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === ">" || char === "<" || char === "|" || char === ";" || char === "&") {
      return true;
    }
    if (char === "$" && next === "(") {
      return true;
    }
    if (char === "`") {
      return true;
    }
  }

  return false;
}

const NODE_EVAL_WRITE_PATTERNS: RegExp[] = [
  /\bfs\s*\.\s*(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|rm(?:Sync)?|unlink(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|cp(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?)\s*\(/,
  /\brequire\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)\s*\.\s*(?:writeFile|appendFile|rm|unlink|rmdir|mkdir|cp|copyFile|rename|truncate)\s*\(/,
  /\bimport\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/,
];

function hasWriteCapableNodeEval(command: string): boolean {
  const match = /\bnode(?:\.exe)?\b[\s\S]*?(?:^|\s)(?:-[A-Za-z]*e[A-Za-z]*|--eval)(?:=|\s+)([\s\S]+)/i.exec(command);
  if (!match) {
    return false;
  }
  const evalSource = match[1] ?? "";
  return NODE_EVAL_WRITE_PATTERNS.some((pattern) => pattern.test(evalSource));
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
