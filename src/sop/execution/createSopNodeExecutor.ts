import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { AttachmentResolver } from "../../context/attachments/AttachmentResolver.js";
import type { AgentHandle } from "../../agent/scope/AgentHandle.js";
import type { CanonicalMessage } from "../../model/index.js";
import type { SopCall, SopJson } from "./SopExecutionClient.js";
import type { SopNodeExecutor } from "./SopExecutionHost.js";

export function createSopNodeExecutor(options: {
  createSession(call: SopCall): Promise<AgentHandle>;
  defaultModel(scope: string): { provider: string; model: string };
  validate?(call: SopCall): void;
}): SopNodeExecutor {
  return async (call, signal) => {
    options.validate?.(call);
    const directory = join(call.scope, ".sop-results", call.runId, call.executionId, `${call.id}-${call.attempt}`);
    await mkdir(directory, { recursive: true });
    const materialize = async (value: unknown): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(materialize));
      if (!value || typeof value !== "object") return value;
      const record = value as SopJson;
      if (Object.hasOwn(record, "sopInlineAttachments")) return inlineAttachments(record.sopInlineAttachments, call.scope);
      // File references remain references. Only explicit attachments mappings are resolved below.
      return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await materialize(item)])));
    };
    const resolvedInput = await materialize(call.input) as SopJson;
    let result: SopJson | undefined;
    const selected = call.model ?? options.defaultModel(call.scope);
    const model = { provider: selected.provider, model: selected.model };
    let text = JSON.stringify(resolvedInput);
    if (call.template) text = call.template.replace(/\{\{([\w]+)\}\}/g, (_, name: string) => {
      if (!(name in resolvedInput)) throw new Error(`Unknown SOP template field: ${name}`);
      return typeof resolvedInput[name] === "string" ? resolvedInput[name] as string : JSON.stringify(resolvedInput[name]);
    });
    const prompt = ["Execute this SOP node and call structured_output exactly once with the result object.",
      "Result fields: status (completed or failed), reply (string), optional handoffText (string), slotUpdates (object), output (JSON), nextNodeId (string). Omit optional fields when unused; never use null for handoffText or slotUpdates.",
      call.node.type === "foreach" ? 'This is a foreach planning node. Call structured_output with value shaped exactly as {"status":"completed","reply":"summary","foreach":{"items":[{"itemKey":"unique-key","input":{}}],"concurrency":1}}. foreach MUST be a top-level result field alongside status, never nested under output. Decide concurrency for the actual work. The Runtime executes child SOPs; do not execute them yourself.' : "",
      call.allowedNextNodeIds?.length ? `Allowed nextNodeId values: ${JSON.stringify(call.allowedNextNodeIds)}` : "This is a terminal node. Omit nextNodeId entirely. Do not invent a completion node or END identifier.",
      `Node instruction: ${call.node.instruction ?? ""}`, `Output directory: ${directory}`,
      `Invocation: ${call.invocation}; attempt: ${call.attempt}`,
      call.approvalResponse ? `Authorized approval response: ${call.approvalResponse}` : "", `Input:\n${text}`].filter(Boolean).join("\n\n");
    const handle = await options.createSession(call);
    const abort = () => handle.abort("sop_execution_cancelled");
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      for await (const event of handle.submit({ type: "text", text: prompt }, {
        turnId: `sop-${call.id}-${call.attempt}`, modelOverride: model,
        ...(call.history.length ? { syntheticMessages: call.history as CanonicalMessage[] } : {}),
        metadata: { sopRunId: call.runId, sopCallId: call.id, sopAttempt: call.attempt },
      })) {
        if (event.type === "turn_completed") {
          const raw = event.result.structuredOutput;
          let value = raw;
          if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { /* Invalid results fail below. */ } }
          if (value && typeof value === "object" && !Array.isArray(value)) {
            result = { ...value as SopJson, model, usage: event.result.usage };
            for (const key of ["handoffText", "slotUpdates", "nextNodeId"]) if (result[key] === null) delete result[key];
          }
        }
      }
      if (!result) return { status: "failed", model, error: { code: "SOP_NODE_RESULT_REQUIRED", message: "Node ended without structured_output" } };
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      await handle.dispose();
    }
  };
}

async function inlineAttachments(value: unknown, scope: string): Promise<unknown> {
  const single = !Array.isArray(value);
  const files = Array.isArray(value) ? value : [value];
  const root = await realpath(scope);
  const resolved = await Promise.all(files.map(async file => {
    const entry = typeof file === "string" ? { path: file } : file as SopJson;
    const path = await realpath(String(entry.path));
    const local = relative(root, path);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Attachment must remain inside the run project");
    const result = await new AttachmentResolver().resolve({ type: "file", path, name: String(entry.name ?? path) });
    if (result.diagnostics.length) throw new Error(result.diagnostics.map(d => d.message).join("; "));
    return { ...entry, content: result.blocks };
  }));
  return single ? resolved[0] : resolved;
}
