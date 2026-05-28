/**
 * `PluginToToolBridge` — converts the runtime view of MCP tools (advertised
 * by an `McpRuntime`) into PilotDeck `ToolDefinition`s suitable for
 * registration in `ToolRegistry`. Implements M10-M12 of §6.1:
 *
 *   - M10  wire name `mcp__<serverId>__<toolName>` (already produced by
 *          `McpClient.listTools`).
 *   - M11  description ≤ 2048 chars (already truncated).
 *   - M12  annotations.readOnlyHint / destructiveHint / openWorldHint
 *          reflected onto the PilotDeck tool flags so the permission
 *          engine can decide whether to ask.
 *
 * Result transformation (M14): we currently emit a single `json` result
 * block. The existing `ToolRuntime` already truncates oversized payloads
 * via `maxResultBytes`; deferring the persisted-large-blob path for now
 * (recorded as `intentional_difference` in the parity table).
 */

import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolInputSchema,
} from "../../tool/index.js";
import type { McpClient } from "../client/McpClient.js";
import type { McpRuntime } from "./McpRuntime.js";
import type {
  PilotDeckMcpToolAnnotations,
  PilotDeckMcpToolSpec,
} from "../protocol/types.js";

export type CreateToolDefinitionsOptions = {
  /** Per-call timeout override (default falls through to McpClient default). */
  callTimeoutMs?: number;
};

export async function createMcpToolDefinitionsFromRuntime(
  runtime: McpRuntime,
  options: CreateToolDefinitionsOptions = {},
): Promise<PilotDeckToolDefinition[]> {
  const tools = await runtime.listAllTools();
  return tools.map((spec) => buildToolDefinition(spec, runtime, options));
}

function buildToolDefinition(
  spec: PilotDeckMcpToolSpec,
  runtime: McpRuntime,
  options: CreateToolDefinitionsOptions,
): PilotDeckToolDefinition {
  const annotations: PilotDeckMcpToolAnnotations = spec.annotations ?? {};
  const isReadOnly = annotations.readOnlyHint === true;
  const isDestructive = annotations.destructiveHint === true;
  const isOpenWorld = annotations.openWorldHint !== false;

  const inputSchema = normalizeSchema(spec.inputSchema);

  return {
    name: spec.wireName,
    description: spec.description,
    kind: "mcp",
    inputSchema,
    maxResultBytes: 200_000,
    isReadOnly: () => isReadOnly,
    isConcurrencySafe: () => isReadOnly,
    isDestructive: () => isDestructive,
    isOpenWorld: () => isOpenWorld,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput> => {
      const client: McpClient | undefined = runtime.getClient(spec.serverId);
      if (!client) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `MCP server ${spec.serverId} is not registered`,
        );
      }
      try {
        const { content, isError } = await client.callTool(spec.toolName, input, {
          signal: context.abortSignal,
          timeoutMs: options.callTimeoutMs,
        });
        if (isError === true) {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            extractMcpErrorText(content, spec.serverId, spec.toolName),
            { content },
          );
        }
        return {
          content: [{ type: "json", value: content }],
          data: content,
          metadata: {
            mcp: { serverId: spec.serverId, toolName: spec.toolName, wireName: spec.wireName },
          },
        };
      } catch (err) {
        if (err instanceof PilotDeckToolRuntimeError) throw err;
        const e = err as { code?: string; message?: string };
        if (e.code === "mcp_call_timeout") {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            e.message ?? `MCP call timed out (${spec.serverId}/${spec.toolName})`,
            { errorCode: "mcp_call_timeout" },
          );
        }
        if (e.code === "mcp_session_expired") {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            e.message ?? `MCP session expired (${spec.serverId}/${spec.toolName})`,
            { errorCode: "mcp_session_expired" },
          );
        }
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          e.message ?? `MCP call failed (${spec.serverId}/${spec.toolName})`,
          { errorCode: e.code ?? "mcp_call_failed" },
        );
      }
    },
  };
}

function extractMcpErrorText(
  content: unknown,
  serverId: string,
  toolName: string,
): string {
  const fallback = `MCP server ${serverId}/${toolName} returned isError`;
  if (!Array.isArray(content)) return fallback;
  const texts = content
    .filter(
      (block: unknown): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string",
    )
    .map((block) => block.text);
  if (texts.length === 0) return fallback;
  return texts.join("\n");
}

function normalizeSchema(raw: unknown): PilotDeckToolInputSchema {
  if (raw && typeof raw === "object") {
    const obj = raw as PilotDeckToolInputSchema;
    if (obj.type === "object") return obj;
  }
  return { type: "object", additionalProperties: true, properties: {} };
}
