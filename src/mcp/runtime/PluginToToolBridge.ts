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
 * Result transformation (M14): MCP ContentBlock types `text` and `image`
 * are mapped to their PilotDeck equivalents so that images (e.g. Playwright
 * screenshots) render inline in the chat UI. Remaining block types
 * (`audio`, `resource`, `resource_link`) fall through as a single `json`
 * block until the downstream pipeline supports them.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolInputSchema,
  PilotDeckToolResultContent,
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
    isConcurrencySafe: () => isReadOnly && runtime.getClient(spec.serverId)?.spec.concurrencySafe !== false,
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
        const { content, structuredContent, isError } = await client.callTool(spec.toolName, input, {
          signal: context.abortSignal,
          timeoutMs: options.callTimeoutMs,
        });
        if (isError === true) {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            extractMcpErrorText(content, spec.serverId, spec.toolName),
            { content, structuredContent },
          );
        }
        const marshaled = marshalMcpContent(content, client.spec.transport === "stdio" ? client.spec.cwd : undefined);
        if (structuredContent !== undefined) {
          const serialized = JSON.stringify(structuredContent);
          // MCP servers may already provide a JSON text fallback for this object.
          if (!marshaled.some(block => block.type === "text" && block.text.trim() === serialized)) {
            marshaled.push({ type: "json", value: structuredContent });
          }
        }
        return {
          content: marshaled,
          data: structuredContent ?? content,
          metadata: {
            mcp: { serverId: spec.serverId, toolName: spec.toolName, wireName: spec.wireName },
          },
        };
      } catch (err) {
        if (context.abortSignal?.aborted) {
          throw new PilotDeckToolRuntimeError("tool_aborted", `MCP call cancelled (${spec.serverId}/${spec.toolName})`);
        }
        if (err instanceof PilotDeckToolRuntimeError) throw err;
        const e = err as { code?: string; message?: string };
        if (e.code === "mcp_call_timeout") {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            `${e.message ?? `MCP call timed out (${spec.serverId}/${spec.toolName})`}. The operation may have executed; observe current state before retrying an action.`,
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

type McpContentBlock = { type: string; [key: string]: unknown };

/**
 * Map MCP `ContentBlock[]` → `PilotDeckToolResultContent[]`.
 *
 * `TextContent`  → `{ type: "text" }`
 * `ImageContent` → `{ type: "image" }` (renders inline in chat)
 * Everything else falls through as a single `json` block.
 *
 * When `cwd` is provided and no inline image block is present, the function
 * scans text blocks for Markdown image links (`[…](./file.png)`) and reads
 * the referenced files from disk so that screenshots taken with a
 * user-specified `filename` (which `@playwright/mcp` saves without returning
 * base64 data) still render inline in the chat UI.
 */
function marshalMcpContent(raw: unknown, cwd?: string): PilotDeckToolResultContent[] {
  if (!Array.isArray(raw)) return [{ type: "json", value: raw }];

  const result: PilotDeckToolResultContent[] = [];
  const remainder: unknown[] = [];
  let hasImageBlock = false;

  for (const block of raw as McpContentBlock[]) {
    if (!block || typeof block !== "object" || typeof block.type !== "string") {
      remainder.push(block);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      result.push({ type: "image", mimeType: block.mimeType as string, data: block.data as string });
      hasImageBlock = true;
    } else {
      remainder.push(block);
    }
  }

  if (!hasImageBlock && cwd) {
    for (const block of raw as McpContentBlock[]) {
      if (block?.type === "text" && typeof block.text === "string") {
        const images = extractFileImages(block.text as string, cwd);
        for (const img of images) result.push(img);
      }
    }
  }

  if (remainder.length > 0) {
    result.push({ type: "json", value: remainder });
  }
  if (result.length === 0) {
    result.push({ type: "json", value: raw });
  }
  return result;
}

const IMAGE_LINK_RE = /\[.*?\]\((\.[^)]*\.(?:png|jpe?g|gif|webp))\)/gi;

/**
 * Extract image file references from Markdown text, read the files from disk,
 * and return them as base64 image blocks.
 */
function extractFileImages(text: string, cwd: string): PilotDeckToolResultContent[] {
  const results: PilotDeckToolResultContent[] = [];
  for (const match of text.matchAll(IMAGE_LINK_RE)) {
    const relPath = match[1];
    try {
      const absPath = resolvePath(cwd, relPath);
      const data = readFileSync(absPath);
      const ext = relPath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/png";
      results.push({ type: "image", mimeType, data: data.toString("base64") });
    } catch {
      // File not readable — skip silently; the text link remains as-is.
    }
  }
  return results;
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
