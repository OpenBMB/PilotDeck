import type { PilotDeckToolResult } from "../../tool/protocol/result.js";

export const COUNTED_TOOL_ERROR_CODES: ReadonlySet<string> = new Set([
  "tool_execution_failed",
  "tool_unavailable",
  "setup_required",
]);

export function resolveToolUnit(
  toolName: string,
  limits: Record<string, number>,
): { unit: string; limit: number } | undefined {
  if (Object.hasOwn(limits, toolName)) {
    return { unit: toolName, limit: limits[toolName]! };
  }

  let match: { unit: string; limit: number } | undefined;
  for (const [unit, limit] of Object.entries(limits)) {
    if (!unit.endsWith("__") || !toolName.startsWith(unit)) continue;
    if (!match || unit.length > match.unit.length) match = { unit, limit };
  }
  return match;
}

export function toolLabel(unit: string, labels?: Record<string, string>): string {
  if (labels && Object.hasOwn(labels, unit)) return labels[unit]!;
  return unit;
}

export function isCountedToolFailure(result: PilotDeckToolResult): boolean {
  return result.type === "error" && COUNTED_TOOL_ERROR_CODES.has(result.error.code);
}
