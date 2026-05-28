/**
 * M10 — wire-name construction for MCP-advertised tools.
 *
 * Format: `mcp__<serverId>__<toolName>`.
 *
 * Both segments are sanitized to `[A-Za-z0-9_-]` to keep the wire name
 * safe across providers (OpenAI / Anthropic disagree on what's legal in
 * tool names; sticking to ASCII alphanumeric + underscore + dash is the
 * lowest common denominator).
 */

export function buildMcpToolWireName(serverId: string, toolName: string): string {
  return `mcp__${normalizeSegment(serverId)}__${normalizeSegment(toolName)}`;
}

export function parseMcpToolWireName(
  wireName: string,
): { serverId: string; toolName: string } | null {
  if (!wireName.startsWith("mcp__")) return null;
  const rest = wireName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const serverId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (!serverId || !toolName) return null;
  return { serverId, toolName };
}

function normalizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}
