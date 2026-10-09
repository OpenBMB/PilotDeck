import path from "node:path";
import { realpathSync } from "node:fs";
import { resolveRealWritePath } from "../../tool/builtin/filesystem/pathSafety.js";
import type { PermissionContext, PermissionRule } from "../protocol/types.js";

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_PATH_PATTERN_TOOLS = new Set(["read_file", "send_attachment", "write_file", "edit_file"]);

export function matchPermissionRule(
  rule: PermissionRule,
  toolName: string,
  input?: unknown,
  context?: PermissionContext,
): boolean {
  if (!matchesToolName(rule.toolName, toolName)) {
    return false;
  }

  if (FILE_WRITE_TOOLS.has(toolName) && !rule.pattern) {
    return isFileInputInsideWorkspace(input, context, rule.behavior === "allow");
  }

  return rule.pattern ? matchRulePattern(rule, toolName, input, context) : true;
}

function matchesToolName(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true;
  return ruleToolName.includes("*") && wildcardToRegExp(ruleToolName).test(toolName);
}

function matchRulePattern(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
  context: PermissionContext | undefined,
): boolean {
  if (!rule.pattern) return true;
  if (toolName === "bash") return matchBashPattern(rule.pattern, input);
  if (FILE_PATH_PATTERN_TOOLS.has(toolName)) return matchFilePathPattern(rule.pattern, input, context);
  return true;
}

function matchBashPattern(pattern: string, input: unknown): boolean {
  const command = readCommand(input);
  if (!command) return false;
  const normalizedPattern = pattern.replace(/:\*$/, "*");
  return wildcardToRegExp(normalizedPattern).test(command);
}

function readCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" ? command.trim() : "";
  }
  return "";
}

function matchFilePathPattern(pattern: string, input: unknown, context: PermissionContext | undefined): boolean {
  const filePath = resolveInputFilePath(input, context);
  return filePath ? wildcardToRegExp(normalizePathForPattern(pattern)).test(normalizePathForPattern(filePath)) : false;
}

function isFileInputInsideWorkspace(
  input: unknown,
  context: PermissionContext | undefined,
  resolveSymlinks: boolean,
): boolean {
  const filePath = resolveInputFilePath(input, context);
  if (!filePath || !context) return false;
  const roots = [context.cwd, ...context.additionalWorkingDirectories].map((root) => path.resolve(root));
  if (!roots.some((root) => isPathWithinRoot(filePath, root))) return false;
  if (!resolveSymlinks) return true;
  // A symlink inside the workspace can still point the write elsewhere.
  const realFilePath = resolveRealWritePath(filePath);
  if (!realFilePath) return false;
  return roots.map(safeRealpath).some((root) => isPathWithinRoot(realFilePath, root));
}

function safeRealpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function resolveInputFilePath(input: unknown, context: PermissionContext | undefined): string | undefined {
  const filePath = readFilePath(input);
  if (!filePath || filePath.includes("\0") || !context) return undefined;
  return path.resolve(path.isAbsolute(filePath) ? filePath : path.join(context.cwd, filePath));
}

function readFilePath(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as { file_path?: unknown; filePath?: unknown };
  const filePath = record.file_path ?? record.filePath;
  return typeof filePath === "string" ? filePath.trim() : "";
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePathForPattern(value: string): string {
  return value.replace(/\\/g, "/");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
