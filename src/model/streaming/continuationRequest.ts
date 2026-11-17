import type { CanonicalModelRequest } from "../protocol/canonical.js";
import { buildCachePlan, selectRecentMessageBreakpoints } from "../../context/cache/CachePlan.js";

export const LITELLM_CONTINUATION_INSTRUCTION =
  "You are a helpful assistant. You are given a message and you need to respond to it. " +
  "You are also given a generated content. You need to respond to the message in continuation of the generated content. " +
  "Do not repeat the same content. Your response should be in continuation of this text:";

export function buildLiteLLMContinuationRequest<T extends CanonicalModelRequest>(
  original: T,
  partialText: string,
): T {
  const messages: CanonicalModelRequest["messages"] = [
    ...stripLiteLLMContinuationMessages(original.messages),
    { role: "assistant", content: [{ type: "text", text: partialText }] },
    { role: "user", content: [{ type: "text", text: LITELLM_CONTINUATION_INSTRUCTION }] },
  ];
  const cachePlan = original.cachePlan
    ? buildCachePlan({ ...original, messages, tools: original.tools ?? [], enabled: true }, original.cachePlan.generation)
    : undefined;
  if (cachePlan && original.cachePlan) {
    cachePlan.system = original.cachePlan.system;
    cachePlan.tools = original.cachePlan.tools;
    if (original.cachePlan.messages.length === 0) cachePlan.messages = [];
  }
  return {
    ...original,
    messages,
    // Recompute indices for each continuation while preserving the caller's
    // cache opt-in. Providers without explicit cache metadata remain unchanged.
    cacheBreakpoints: cachePlan?.messages ?? (original.cacheBreakpoints === undefined ? undefined
      : original.cacheBreakpoints.length === 0 ? [] : selectRecentMessageBreakpoints(messages)),
    cachePlan,
  };
}

export function stripLiteLLMContinuationMessages(
  messages: CanonicalModelRequest["messages"],
): CanonicalModelRequest["messages"] {
  if (messages.length < 2) return messages;
  const last = messages[messages.length - 1];
  const secondLast = messages[messages.length - 2];
  if (
    last.role === "user" &&
    secondLast.role === "assistant" &&
    last.content.length === 1 &&
    last.content[0].type === "text" &&
    last.content[0].text === LITELLM_CONTINUATION_INSTRUCTION
  ) {
    return messages.slice(0, -2);
  }
  return messages;
}
