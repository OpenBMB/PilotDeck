import type {
  CanonicalContentBlock,
  CanonicalFinishReason,
  CanonicalModelResponse,
  CanonicalThinkingBlock,
  CanonicalToolCallBlock,
  CanonicalUsage,
} from "../../protocol/canonical.js";

export function parseGoogleResponse(raw: unknown, provider = "google"): CanonicalModelResponse {
  const response = asRecord(raw);
  const candidate = firstCandidate(response);
  const parts = contentParts(candidate);
  const idState = createToolCallIdState(response);

  return {
    role: "assistant",
    content: parts.flatMap((part, index) => toCanonicalContentBlock(part, provider, idState, index)),
    usage: normalizeGoogleUsage(response.usageMetadata),
    finishReason: normalizeGoogleFinishReason(candidate.finishReason),
    raw,
  };
}

export function normalizeGoogleUsage(raw: unknown): CanonicalUsage | undefined {
  const usage = asRecord(raw);
  const inputTokens = readNumber(usage.promptTokenCount);
  const outputTokens = readNumber(usage.candidatesTokenCount) ?? readNumber(usage.responseTokenCount);
  const cacheReadTokens = readNumber(usage.cachedContentTokenCount);
  const totalTokens = readNumber(usage.totalTokenCount) ?? sumDefined(inputTokens, outputTokens, cacheReadTokens);
  const result: CanonicalUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

export function normalizeGoogleFinishReason(reason: unknown): CanonicalFinishReason {
  switch (typeof reason === "string" ? reason.toUpperCase() : reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "tool_call";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    default:
      return "unknown";
  }
}

function toCanonicalContentBlock(
  part: unknown,
  provider: string,
  idState: GoogleToolCallIdState,
  partIndex: number,
): CanonicalContentBlock[] {
  const record = asRecord(part);
  const text = readString(record.text);
  if (text !== undefined) {
    if (record.thought === true) {
      const thinking: CanonicalThinkingBlock = { type: "thinking", text };
      const signature = readString(record.thoughtSignature);
      if (signature) {
        thinking.signature = signature;
      }
      return [thinking];
    }
    return text.length > 0 ? [{ type: "text", text }] : [];
  }

  const functionCall = asRecord(record.functionCall);
  if (Object.keys(functionCall).length > 0) {
    return [toCanonicalToolCall(functionCall, provider, idState, partIndex)];
  }

  return [];
}

function toCanonicalToolCall(
  functionCall: Record<string, unknown>,
  provider: string,
  idState: GoogleToolCallIdState,
  partIndex: number,
): CanonicalToolCallBlock {
  const args = functionCall.args;
  return {
    type: "tool_call",
    id: chooseGoogleToolCallId(idState, readString(functionCall.id), partIndex),
    name: readString(functionCall.name) ?? "",
    input: args && typeof args === "object" && !Array.isArray(args) ? args : {},
    raw: {
      provider,
      functionCall,
    },
  };
}

type GoogleToolCallIdState = {
  baseId: string;
  usedIds: Set<string>;
};

function createToolCallIdState(response: Record<string, unknown>): GoogleToolCallIdState {
  return {
    baseId: safeToolCallIdPart(readString(response.responseId) ?? "google_response"),
    usedIds: new Set(),
  };
}

function chooseGoogleToolCallId(
  state: GoogleToolCallIdState,
  incomingId: string | undefined,
  index: number,
): string {
  const candidate = incomingId ? safeToolCallIdPart(incomingId) : `call_${state.baseId}_${index}`;
  const unique = nextUniqueToolCallId(candidate, state.usedIds);
  state.usedIds.add(unique);
  return unique;
}

function nextUniqueToolCallId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    return id;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function safeToolCallIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "google";
}

function firstCandidate(response: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  return asRecord(candidates[0]);
}

function contentParts(candidate: Record<string, unknown>): unknown[] {
  const content = asRecord(candidate.content);
  return Array.isArray(content.parts) ? content.parts : [];
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
