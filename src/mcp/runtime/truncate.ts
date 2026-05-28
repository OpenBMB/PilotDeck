/**
 * M11 — clamp tool descriptions to {@link MAX_MCP_TOOL_DESCRIPTION_LENGTH}
 * characters. OpenAPI-generated MCP servers regularly emit 30+ KB
 * descriptions; without truncation a single tool can blow up the system
 * prompt and break provider-side caches.
 */

export const MAX_MCP_TOOL_DESCRIPTION_LENGTH = 2048;

export function truncateMcpToolDescription(value: string): string {
  if (value.length <= MAX_MCP_TOOL_DESCRIPTION_LENGTH) return value;
  return value.slice(0, MAX_MCP_TOOL_DESCRIPTION_LENGTH) + "… [truncated]";
}
