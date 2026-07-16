export type ParsedTokenLimitError = {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  availableOutputTokens?: number;
  kind?: "context" | "output";
};

export function parseTokenLimitError(message: string): ParsedTokenLimitError {
  const lower = message.toLowerCase();
  const output = parseOutputLimit(message, lower);
  if (output.maxOutputTokens !== undefined || output.availableOutputTokens !== undefined) {
    return { ...output, kind: "output" };
  }
  const maxContextTokens = parseContextLimit(message, lower);
  if (maxContextTokens !== undefined) {
    return { maxContextTokens, kind: "context" };
  }
  return {};
}

function parseOutputLimit(message: string, lower: string): ParsedTokenLimitError {
  const range = /range of max_tokens should be\s*\[\s*\d+\s*,\s*(\d+)\s*\]/i.exec(message);
  if (range) return { maxOutputTokens: toPositiveInt(range[1]) };

  const available = /available_tokens[:\s]+(\d+)/i.exec(message)
    ?? /available\s+tokens[:\s]+(\d+)/i.exec(message);
  if (available && lower.includes("max_tokens")) {
    return { availableOutputTokens: toPositiveInt(available[1]) };
  }

  const greaterThanContext = /max_tokens[:\s]+\d+\s*>\s*(?:context_window[:\s]+)?(\d+)/i.exec(message)
    ?? /max_tokens[:\s]+\d+[^.]*?(?:exceeds|exceed|greater than)[^.]*?(?:context window|context_window|context length)[^\d]*(\d+)/i.exec(message);
  if (greaterThanContext) return { maxOutputTokens: toPositiveInt(greaterThanContext[1]) };

  const atMost = /max_(?:output_)?tokens?\s+(?:must be |should be |is )?(?:at most|<=|less than or equal to)\s*(\d+)/i.exec(message)
    ?? /max_completion_tokens?\s+(?:must be |should be |is )?(?:at most|<=|less than or equal to)\s*(\d+)/i.exec(message);
  if (atMost) return { maxOutputTokens: toPositiveInt(atMost[1]) };

  const outputTokens = /requested\s+(\d+)\s+output tokens/i.exec(message);
  if (outputTokens && lower.includes("maximum context length")) {
    return { availableOutputTokens: estimateAvailableOutputFromContextError(message) };
  }

  const outputPortion = /maximum context length is\s*(\d+)[\s\S]*?(\d+)\s+(?:tokens?\s+)?(?:of|in)\s+(?:the\s+)?output/i.exec(message);
  if (outputPortion) {
    const context = toPositiveInt(outputPortion[1]);
    const outputUsed = toPositiveInt(outputPortion[2]);
    if (context !== undefined && outputUsed !== undefined) return { availableOutputTokens: Math.max(1, context - outputUsed) };
  }

  return {};
}

function estimateAvailableOutputFromContextError(message: string): number | undefined {
  const context = /maximum context length is\s*(\d+)/i.exec(message);
  if (!context) return undefined;
  const contextTokens = toPositiveInt(context[1]);
  if (contextTokens === undefined) return undefined;
  const promptTokens = /prompt (?:contains|has)\s+(?:at least\s+)?(\d+)\s+(?:tokens|characters)/i.exec(message)
    ?? /input_tokens?[:\s]+(\d+)/i.exec(message);
  const prompt = promptTokens ? toPositiveInt(promptTokens[1]) : undefined;
  if (prompt === undefined) return undefined;
  return Math.max(1, contextTokens - prompt);
}

function parseContextLimit(message: string, lower: string): number | undefined {
  if (lower.includes("max_tokens") && (lower.includes("available_tokens") || lower.includes("range of max_tokens"))) {
    return undefined;
  }
  const patterns = [
    /limit(?: is|:)?\s*(\d+)\s*tokens/i,
    /max_model_len\D{0,30}(\d+)/i,
    /maximum context length(?: is|:)?\s*(\d+)/i,
    /context[_\s-]?window(?: is|:)?\s*(\d+)/i,
    /context[_\s-]?length(?:_exceeded)?[^\d]{0,40}(\d+)/i,
    /最多(?:支持|允许)?\s*(\d+)\s*(?:tokens?|个?token|上下文)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const parsed = match ? toPositiveInt(match[1]) : undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.replace(/_/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
