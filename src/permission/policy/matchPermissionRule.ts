import type { PermissionRule } from "../protocol/types.js";

export function matchPermissionRule(rule: PermissionRule, toolName: string, input?: unknown): boolean {
  if (rule.toolName === toolName) {
    return rule.pattern ? matchRulePattern(rule, input) : true;
  }

  if (!rule.toolName.includes("*")) {
    return false;
  }

  return wildcardToRegExp(rule.toolName).test(toolName) && (!rule.pattern || matchRulePattern(rule, input));
}

function matchRulePattern(rule: PermissionRule, input: unknown): boolean {
  if (!rule.pattern) return true;
  if (rule.toolName !== "bash") return true;
  const command = readCommand(input);
  if (!command) return false;
  const normalizedPattern = rule.pattern.replace(/:\*$/, "*");
  return wildcardToRegExp(normalizedPattern).test(command);
}

function readCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" ? command.trim() : "";
  }
  return "";
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
