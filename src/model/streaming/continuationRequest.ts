import type { CanonicalModelRequest } from "../protocol/canonical.js";

export const LITELLM_CONTINUATION_INSTRUCTION =
  "You are a helpful assistant. You are given a message and you need to respond to it. " +
  "You are also given a generated content. You need to respond to the message in continuation of the generated content. " +
  "Do not repeat the same content. Your response should be in continuation of this text:";

export function buildLiteLLMContinuationRequest<T extends CanonicalModelRequest>(
  original: T,
  partialText: string,
): T {
  return {
    ...original,
    messages: [
      ...stripLiteLLMContinuationMessages(original.messages),
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: partialText }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: LITELLM_CONTINUATION_INSTRUCTION }],
      },
    ],
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
