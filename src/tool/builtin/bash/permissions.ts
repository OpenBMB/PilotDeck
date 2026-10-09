import type { Node } from "web-tree-sitter";
import type { PermissionResult } from "../../../permission/index.js";
import { bashCommandSource, parseBash } from "./parser.js";

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

export function classifyBashPermission(command: string): PermissionResult {
  const analysis = analyzeShellCommand(command);
  // Match the dangerous patterns against the whole string and against every
  // simple command the parser found, so a newline, subshell, or command
  // substitution cannot move a command out of a pattern's anchor position.
  const candidates = [command, ...(analysis?.commandTexts ?? [])];
  const matchesAny = (pattern: RegExp) => candidates.some((candidate) => pattern.test(candidate));

  if (HARD_DENY_PATTERNS.some(matchesAny)) {
    return {
      type: "deny",
      reason: { type: "safety", message: "Dangerous shell command denied." },
      message: "Dangerous shell command denied.",
    };
  }

  if (DANGEROUS_ASK_PATTERNS.some(matchesAny)) {
    return askForShellPermission(command);
  }

  if (analysis && isReadOnlyAnalysis(analysis)) {
    return { type: "passthrough" };
  }

  return askForShellPermission(command);
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
  const analysis = analyzeShellCommand(command);
  return analysis !== undefined && isReadOnlyAnalysis(analysis);
}

/** A word's literal value, or undefined when it depends on an expansion. */
type ShellWord = string | undefined;

interface ShellAnalysis {
  /** Source text of every simple command in the script, including nested ones. */
  commandTexts: string[];
  /** argv of every simple command, or undefined when the script uses syntax outside the read-only subset. */
  readOnlyCandidates: ShellWord[][] | undefined;
}

// Syntax a read-only script may use. Anything else (assignments, control flow,
// functions, command/process substitution, arithmetic, parse errors, ...) is
// treated as possibly side-effecting.
const READ_ONLY_SYNTAX_NODES = new Set([
  "program",
  "list",
  "pipeline",
  "subshell",
  "compound_statement",
  "negated_command",
  "redirected_statement",
  "comment",
  "command",
  "command_name",
  "word",
  "number",
  "raw_string",
  "string",
  "string_content",
  "ansi_c_string",
  "concatenation",
  "simple_expansion",
  "expansion",
  "variable_name",
  "special_variable_name",
  "file_redirect",
  "file_descriptor",
  "heredoc_redirect",
  "heredoc_start",
  "heredoc_body",
  "heredoc_content",
  "heredoc_end",
  "herestring_redirect",
]);

const REDIRECT_NODES = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"]);

function analyzeShellCommand(command: string): ShellAnalysis | undefined {
  const tree = parseBash(command);
  if (!tree) {
    return undefined;
  }
  try {
    const commandTexts: string[] = [];
    const argvs: ShellWord[][] = [];
    let readOnlySyntax = !tree.rootNode.hasError;
    const stack: Node[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === "command") {
        commandTexts.push(bashCommandSource(node));
        argvs.push(readCommandArgv(node));
      }
      // Named nodes must be in the subset; the only rejected anonymous token is a
      // background `&`, which detaches a process the tool cannot track.
      if (node.isNamed ? !READ_ONLY_SYNTAX_NODES.has(node.type) : node.type === "&") {
        readOnlySyntax = false;
      }
      if (node.type === "file_redirect" && !isReadOnlyFileRedirect(node)) {
        readOnlySyntax = false;
      }
      for (const child of node.children) {
        if (child) {
          stack.push(child);
        }
      }
    }
    return { commandTexts, readOnlyCandidates: readOnlySyntax ? argvs : undefined };
  } finally {
    tree.delete();
  }
}

function readCommandArgv(command: Node): ShellWord[] {
  const argv: ShellWord[] = [];
  for (const child of command.namedChildren) {
    if (!child || child.type === "variable_assignment" || REDIRECT_NODES.has(child.type)) {
      continue;
    }
    argv.push(child.type === "command_name" ? readLiteralWord(child.namedChild(0)) : readLiteralWord(child));
  }
  return argv;
}

function readLiteralWord(node: Node | null): ShellWord {
  if (!node) {
    return undefined;
  }
  switch (node.type) {
    case "word":
      return node.text.replace(/\\(.)/gsu, "$1");
    case "number":
      return node.text;
    case "raw_string":
      return node.text.slice(1, -1);
    case "string": {
      let value = "";
      for (const child of node.namedChildren) {
        if (child?.type !== "string_content") {
          return undefined;
        }
        value += child.text.replace(/\\([\\"$`])/gu, "$1");
      }
      return value;
    }
    case "concatenation": {
      let value = "";
      for (const child of node.namedChildren) {
        const part = readLiteralWord(child);
        if (part === undefined) {
          return undefined;
        }
        value += part;
      }
      return value;
    }
    default:
      return undefined;
  }
}

/** Reading files and discarding or duplicating output are fine; writing to a file is not. */
function isReadOnlyFileRedirect(redirect: Node): boolean {
  const operator = redirect.children.find((child) => child && !child.isNamed)?.type;
  const destination = redirect.namedChildren.filter((child) => child?.type !== "file_descriptor").at(-1);
  const target = destination ? readLiteralWord(destination) : undefined;
  if (operator === "<" || target === "/dev/null") {
    return true;
  }
  return (operator === ">&" || operator === "<&") && target !== undefined && /^(?:\d+|-)$/u.test(target);
}

function isReadOnlyAnalysis(analysis: ShellAnalysis): boolean {
  const candidates = analysis.readOnlyCandidates;
  return candidates !== undefined && candidates.length > 0 && candidates.every(isReadOnlyArgv);
}

function isReadOnlyArgv(argv: ShellWord[]): boolean {
  const [commandName, ...args] = argv;
  if (commandName === undefined) {
    return false;
  }
  const normalizedCommandName = normalizeExecutableName(commandName);
  // These commands cannot write regardless of their arguments, so expanded
  // arguments are fine; every other command needs literal arguments to inspect.
  if (SIMPLE_READ_COMMANDS.has(normalizedCommandName) || WINDOWS_READ_COMMANDS.has(normalizedCommandName)) {
    return true;
  }
  if (args.some((arg) => arg === undefined)) {
    return false;
  }
  const literalArgs = args as string[];

  if (normalizedCommandName === "git") {
    const subcommand = getGitSubcommand(literalArgs);
    return (
      subcommand !== undefined
      && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)
      && !literalArgs.some((arg) => arg === "--output" || arg.startsWith("--output="))
    );
  }

  if (isPowerShellCommand(normalizedCommandName)) {
    return isReadOnlyPowerShellInvocation(literalArgs);
  }

  if (normalizedCommandName === "find") {
    return isReadOnlyFindTokens(literalArgs);
  }

  return (
    normalizedCommandName === "sh"
    && literalArgs.length === 2
    && literalArgs[0] === "-c"
    && /^exit\s+\d+$/.test(literalArgs[1]!)
  );
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
  // PowerShell, not bash, parses this text: reject statement separators,
  // including newlines, rather than tokenizing it as one command.
  if (/[{}|;&<>`\r\n]/.test(commandText) || /\$\s*\(/.test(commandText)) {
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
