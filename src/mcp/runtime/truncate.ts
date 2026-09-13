/**
 * M11 — clamp tool descriptions to {@link MAX_MCP_TOOL_DESCRIPTION_LENGTH}
 * characters. OpenAPI-generated MCP servers regularly emit 30+ KB
 * descriptions; without truncation a single tool can blow up the system
 * prompt and break provider-side caches.
 *
 * The cap is a hard limit on the returned string: the truncation marker is
 * reserved inside {@link MAX_MCP_TOOL_DESCRIPTION_LENGTH}, not appended past it.
 */

export const MAX_MCP_TOOL_DESCRIPTION_LENGTH = 2048;

const TRUNCATION_MARKER = "… [truncated]";

export function truncateMcpToolDescription(value: string): string {
  if (value.length <= MAX_MCP_TOOL_DESCRIPTION_LENGTH) return value;
  const headLength = MAX_MCP_TOOL_DESCRIPTION_LENGTH - TRUNCATION_MARKER.length;
  return value.slice(0, headLength) + TRUNCATION_MARKER;
}
