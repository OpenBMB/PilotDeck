import type {
  CanonicalContentBlock,
  CanonicalMessage,
} from "../../protocol/canonical.js";

type ToolOutputBlock = Extract<
  CanonicalContentBlock,
  { type: "tool_result" | "tool_result_reference" }
>;

function outputCallId(block: CanonicalContentBlock): string | undefined {
  return block.type === "tool_result" || block.type === "tool_result_reference"
    ? block.toolCallId
    : undefined;
}

/**
 * Removes malformed structured tool history that Codex rejects.
 *
 * A tool exchange is retained only when its id has exactly one call and an
 * output occurring after that call. For a valid exchange, only the first such
 * output is retained. All other content is preserved verbatim.
 */
export function normalizeCodexHistory(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  const callCounts = new Map<string, number>();
  const callPositions = new Map<string, number>();
  let position = 0;

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") {
        callCounts.set(block.id, (callCounts.get(block.id) ?? 0) + 1);
        callPositions.set(block.id, position);
      }
      position += 1;
    }
  }

  const firstOutputs = new Map<string, ToolOutputBlock>();
  position = 0;
  for (const message of messages) {
    for (const block of message.content) {
      const callId = outputCallId(block);
      if (
        callId !== undefined
        && callCounts.get(callId) === 1
        && position > (callPositions.get(callId) ?? Number.POSITIVE_INFINITY)
        && !firstOutputs.has(callId)
      ) {
        firstOutputs.set(callId, block as ToolOutputBlock);
      }
      position += 1;
    }
  }

  return messages
    .map((message) => ({
      ...message,
      content: message.content.filter((block) => {
        if (block.type === "tool_call") {
          return callCounts.get(block.id) === 1 && firstOutputs.has(block.id);
        }

        const callId = outputCallId(block);
        if (callId !== undefined) {
          return firstOutputs.get(callId) === block;
        }

        return true;
      }),
    }))
    .filter((message) => message.content.length > 0);
}
