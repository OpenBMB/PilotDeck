import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";
import type { SopExecutionClient, SopJson } from "./SopExecutionClient.js";

export const SOP_EXECUTION_TOOLS = ["run_sop", "sop_status", "sop_result", "sop_wait", "sop_cancel", "sop_retry"] as const;

export function createSopExecutionTools(client: SopExecutionClient, inheritedInput?: (sessionId: string) => Promise<SopJson | undefined>): PilotDeckToolDefinition[] {
  return SOP_EXECUTION_TOOLS.map((name): PilotDeckToolDefinition => ({
    name, kind: "custom" as const,
    description: name === "run_sop"
      ? "Start a durable SOP run. Supply sopId, fixed version and either input or items [{itemKey,input}]. Choose concurrency (default 8, deployment cap). Each item executes independently. Returns runId immediately. Use sop_wait/status/result afterwards."
      : `${name}: query or control a SOP run by runId. sop_result returns a summary and resultRef by default; set limit (1..100) for a result page. Retry takes requestId and failed leaf callIds. Cancel takes requestId. Wait timeoutMs is at most 60000.`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { ...(name === "run_sop" ? {
        requestId: { type: "string" }, sopId: { type: "string" }, version: { type: "string" },
        input: { type: "object", additionalProperties: true },
        items: { type: "array", items: { type: "object", required: ["itemKey", "input"], additionalProperties: false,
          properties: { itemKey: { type: "string" }, input: { type: "object", additionalProperties: true } } } },
        concurrency: { type: "integer", minimum: 1 },
        model: { type: "object", additionalProperties: false, required: ["provider", "model"], properties: { provider: { type: "string" }, model: { type: "string" } } },
      } : {
        runId: { type: "string" }, requestId: { type: "string" }, offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 }, timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
        callIds: { type: "array", items: { type: "string" } },
      }) },
      required: name === "run_sop" ? ["requestId", "sopId", "version"] : name === "sop_cancel" || name === "sop_retry" ? ["runId", "requestId"] : ["runId"],
    },
    isReadOnly: () => ["sop_status", "sop_result", "sop_wait"].includes(name),
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      let value = input as SopJson;
      if (name === "run_sop" && inheritedInput) {
        const inherited = await inheritedInput(context.sessionId) ?? {};
        const merge = (own: SopJson): SopJson => {
          const merged = { ...inherited, ...own };
          // Per-item file lists must not inherit other items' attachment bodies.
          if (Object.hasOwn(own, "files") && !Object.hasOwn(own, "attachments")) merged.attachments = own.files;
          return merged;
        };
        value = Array.isArray(value.items) ? { ...value, items: value.items.map(item => {
          const row = item as { itemKey: string; input: SopJson };
          return { ...row, input: merge(row.input) };
        }) } : { ...value, input: merge(value.input as SopJson ?? {}) };
      }
      const data = name === "sop_result" && value.limit === undefined
        ? await client.call("sop_status", context.cwd, { runId: value.runId, limit: 1 }, context.abortSignal)
        : await client.call(name, context.cwd, value, context.abortSignal);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], data };
    },
  }));
}
