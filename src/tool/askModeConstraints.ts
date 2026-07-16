/**
 * Ask mode is a read-only run mode. Permission mode can still be
 * `default` or `bypassPermissions`, but it must not grant write access.
 */

import type { PilotDeckToolDefinition } from "./protocol/types.js";
import { isReadOnlyShellCommand } from "./builtin/bash/permissions.js";

export const ASK_MODE_ALLOWED_TOOLS = new Set([
  "read_file",
  "get_current_time",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "ask_user_question",
  "read_skill",
  "structured_output",
  "agent",
  "execute_code",
  "bash",
  "task_list",
  "task_output",
  "task_wait",
]);

export const ASK_MODE_DESCRIPTION_SUFFIX: Record<string, string> = {
  bash: "\n\n[ASK MODE] READ-ONLY commands only. Write/modify/delete commands will be rejected.",
  agent: "\n\n[ASK MODE] Subagents inherit ask mode and the same permission setting. They can read and search, but cannot modify files.",
  execute_code: "\n\n[ASK MODE] READ-ONLY Python scripts only. Scripts that call write_file, edit_file, or non-read-only bash commands will be rejected.",
};

const ASK_MODE_VIOLATION_HEADER = "[ASK_MODE_VIOLATION]";

export function isAskModeAllowedTool(tool: PilotDeckToolDefinition): boolean {
  if (tool.kind === "mcp") {
    return tool.isReadOnly({} as never);
  }
  return ASK_MODE_ALLOWED_TOOLS.has(tool.name);
}

export function buildAskModeViolationMessage(toolName: string): string {
  return [
    `${ASK_MODE_VIOLATION_HEADER} Tool "${toolName}" is BLOCKED in ask mode.`,
    "",
    "Ask mode is read-only. Tools may inspect files, search, ask questions, fetch/read external content, or launch read-only subagents, but they cannot modify files or create side effects.",
    "",
    "Do NOT retry this tool. It will fail again while ask mode is active.",
  ].join("\n");
}

export function buildAskModeBashViolationMessage(command: string): string {
  const truncated = command.length > 120 ? command.slice(0, 120) + "…" : command;
  return [
    `${ASK_MODE_VIOLATION_HEADER} bash command "${truncated}" is BLOCKED because it is not read-only.`,
    "",
    "In ask mode, bash is restricted to read-only commands only (pwd, ls, cat, head, wc, git status, git diff, git log, git show, find without write actions, etc.).",
  ].join("\n");
}

export function getAskModeViolation(
  tool: PilotDeckToolDefinition,
  input: unknown,
): string | undefined {
  if (!isAskModeAllowedTool(tool)) {
    return buildAskModeViolationMessage(tool.name);
  }

  if (tool.name === "bash") {
    const command = readStringProperty(input, "command");
    if (!command || !isReadOnlyShellCommand(command)) {
      return buildAskModeBashViolationMessage(command ?? "");
    }
    return undefined;
  }

  if (!tool.isReadOnly(input) && tool.name !== "agent") {
    return buildAskModeViolationMessage(tool.name);
  }

  return undefined;
}

function readStringProperty(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function isAskModeViolationText(text: unknown): boolean {
  return typeof text === "string" && text.includes(ASK_MODE_VIOLATION_HEADER);
}
