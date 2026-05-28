import type { CanonicalToolCall } from "../../model/index.js";
import type { PilotDeckToolErrorResult, PilotDeckToolResult } from "../../tool/index.js";

export function ensureToolResultPairing(
  calls: CanonicalToolCall[],
  results: PilotDeckToolResult[],
  now: () => Date = () => new Date(),
  message = "Tool execution did not produce a result.",
): PilotDeckToolResult[] {
  const resultsByCallId = new Map(results.map((result) => [result.toolCallId, result]));
  const paired: PilotDeckToolResult[] = [];

  for (const call of calls) {
    paired.push(resultsByCallId.get(call.id) ?? createMissingToolResult(call, now, message));
  }

  return paired;
}

export function createMissingToolResult(
  call: CanonicalToolCall,
  now: () => Date = () => new Date(),
  message = "Tool execution did not produce a result.",
): PilotDeckToolErrorResult {
  const timestamp = now().toISOString();
  return {
    type: "error",
    toolCallId: call.id,
    toolName: call.name,
    error: {
      code: "tool_execution_failed",
      message,
    },
    content: [{ type: "text", text: message }],
    startedAt: timestamp,
    completedAt: timestamp,
  };
}
