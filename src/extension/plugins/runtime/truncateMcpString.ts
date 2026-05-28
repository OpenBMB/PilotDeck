/**
 * Match legacy `services/mcp/client.ts` `MAX_MCP_DESCRIPTION_LENGTH = 2048`.
 * OpenAPI-generated MCP servers routinely dump 15–60 KB instruction blobs;
 * the cap keeps the system prompt within budget and stable across rebuilds.
 */
export const MAX_MCP_INSTRUCTION_LENGTH = 2048;

export function truncateMcpInstructionString(value: string): string {
  if (value.length <= MAX_MCP_INSTRUCTION_LENGTH) return value;
  return value.slice(0, MAX_MCP_INSTRUCTION_LENGTH) + "… [truncated]";
}
