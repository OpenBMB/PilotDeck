import type { PermissionResult } from "../../../permission/index.js";

const DENY_PATTERNS: RegExp[] = [
  // Unix
  /\brm\s+-[^&|;]*r[^&|;]*f\s+\//,
  // sudo as a command (not inside quotes, e.g. `git log -S "sudo"`)
  /(?:^|[;&|]\s*)sudo\b/,
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

const SAFE_READ_PATTERNS: RegExp[] = [
  // Unix / cross-platform
  /^\s*pwd\s*$/,
  /^\s*ls(?:\s|$)/,
  /^\s*wc\s+-l(?:\s+["'][^"']+["']|\s+[^\s;&|<>`]+)+\s*$/,
  /^\s*git\s+status(?:\s|$)/,
  /^\s*git\s+diff(?:\s|$)/,
  /^\s*git\s+log(?:\s|$)/,
  /^\s*printf(?:\s|$)/,
  /^\s*echo(?:\s|$)/,
  /^\s*node\s+-e\s+/,
  /^\s*sh\s+-c\s+["']exit\s+\d+["']\s*$/,

  // Windows — PowerShell read-only cmdlets
  /^\s*Get-ChildItem(?:\s|$)/i,
  /^\s*Get-Location\s*$/i,
  /^\s*Get-Content(?:\s|$)/i,
  /^\s*Get-Process(?:\s|$)/i,
  /^\s*Get-Item(?:\s|$)/i,
  /^\s*Get-ItemProperty(?:\s|$)/i,
  /^\s*Test-Path(?:\s|$)/i,
  /^\s*Select-String(?:\s|$)/i,
  /^\s*Get-Date\s*$/i,
  /^\s*whoami\s*$/i,
  // Windows — CMD read-only commands
  /^\s*dir(?:\s|$)/i,
  /^\s*type(?:\s|$)/i,
  /^\s*where(?:\s|$)/i,
];

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
  return SAFE_READ_PATTERNS.some((pattern) => pattern.test(command));
}
