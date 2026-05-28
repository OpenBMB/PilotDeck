import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type PilotDeckMcpResourceAdapter = {
  listResources(serverId?: string): Promise<unknown>;
  readResource(serverId: string, uri: string): Promise<unknown>;
};

export function createListMcpResourcesTool(adapter?: PilotDeckMcpResourceAdapter): PilotDeckToolDefinition {
  return {
    name: "list_mcp_resources",
    aliases: ["ListMcpResourcesTool"],
    description: "List resources exposed by configured MCP servers.",
    kind: "mcp",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        serverId: {
          type: "string",
          description: "Optional MCP server id to filter resources. Omit to list all servers.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input) => {
      if (!adapter) {
        throw new PilotDeckToolRuntimeError("unsupported_tool", "MCP resource adapter is not configured.");
      }
      const value = await adapter.listResources((input as { serverId?: string }).serverId);
      return { content: [{ type: "json", value }], data: value };
    },
  };
}

export function createReadMcpResourceTool(adapter?: PilotDeckMcpResourceAdapter): PilotDeckToolDefinition {
  return {
    name: "read_mcp_resource",
    aliases: ["ReadMcpResourceTool"],
    description: "Read a resource exposed by a configured MCP server.",
    kind: "mcp",
    inputSchema: {
      type: "object",
      required: ["serverId", "uri"],
      additionalProperties: false,
      properties: {
        serverId: {
          type: "string",
          description: "MCP server identifier that hosts the resource.",
        },
        uri: {
          type: "string",
          description: "Resource URI to read (as listed by list_mcp_resources).",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input) => {
      if (!adapter) {
        throw new PilotDeckToolRuntimeError("unsupported_tool", "MCP resource adapter is not configured.");
      }
      const typedInput = input as { serverId: string; uri: string };
      const value = await adapter.readResource(typedInput.serverId, typedInput.uri);
      return { content: [{ type: "json", value }], data: value };
    },
  };
}
