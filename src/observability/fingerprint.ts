import { createHash } from "node:crypto";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../model/index.js";

export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function observationHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function observationBytes(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

export function fingerprintMessages(messages: readonly CanonicalMessage[]): {
  messageSetHash: string;
  messageCount: number;
  bytes: number;
  messages: Array<Record<string, unknown>>;
} {
  return {
    messageSetHash: observationHash(messages),
    messageCount: messages.length,
    bytes: observationBytes(messages),
    messages: messages.map((message, index) => ({
      index,
      role: message.role,
      hash: observationHash(message),
      bytes: observationBytes(message),
      synthetic: message.metadata?.synthetic === true,
      transient: message.metadata?.transient === true,
      ...(typeof message.metadata?.purpose === "string" ? { purpose: message.metadata.purpose } : {}),
    })),
  };
}

export function fingerprintModelRequest(request: CanonicalModelRequest): Record<string, unknown> {
  const messages = fingerprintMessages(request.messages);
  const systemPrompt = request.systemPrompt ?? "";
  const tools = request.tools ?? [];
  return {
    requestHash: observationHash(request),
    requestBytes: observationBytes(request),
    ...messages,
    systemPrompt: {
      hash: observationHash(systemPrompt),
      bytes: Buffer.byteLength(systemPrompt, "utf8"),
      present: systemPrompt.length > 0,
    },
    tools: tools.map((tool) => ({
      name: tool.name,
      hash: observationHash(tool),
      bytes: observationBytes(tool),
    })),
    parameters: {
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
      stream: request.stream,
      thinkingEnabled: request.thinking?.enabled === true,
    },
  };
}

export function fingerprintModelResponse(
  events: readonly CanonicalModelEvent[],
  usage?: unknown,
): Record<string, unknown> {
  const safeEvents = events.map((event) => {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta":
        return { type: event.type, hash: observationHash(event.text), bytes: Buffer.byteLength(event.text, "utf8") };
      case "tool_call_end":
        return {
          type: event.type,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          inputHash: observationHash(event.toolCall.input),
          inputBytes: observationBytes(event.toolCall.input),
        };
      case "message_end":
        return { type: event.type, finishReason: event.finishReason };
      case "usage":
        return { type: event.type, usage: event.usage };
      case "error":
        return { type: event.type, code: event.error.code, retryable: event.error.retryable };
      default:
        return { type: event.type };
    }
  });
  const finish = [...events].reverse().find((event) => event.type === "message_end");
  return {
    responseHash: observationHash(safeEvents),
    eventCount: events.length,
    finishReason: finish?.type === "message_end" ? finish.finishReason : "unknown",
    reasoning: {
      availability: events.some((event) => event.type === "thinking_delta") ? "policy_omitted" : "not_exposed",
      capturePolicy: "hash_only",
    },
    ...(usage ? { usage } : {}),
  };
}

export function fingerprintToolResult(result: unknown): Record<string, unknown> {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return {
    outputHash: observationHash(result),
    outputBytes: observationBytes(result),
    success: record.type === "success",
    errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined,
  };
}
