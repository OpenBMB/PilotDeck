import type { CanonicalMessage, CanonicalToolCall } from "../../model/index.js";

export function collectToolCalls(message: CanonicalMessage): CanonicalToolCall[] {
  return message.content.flatMap((block) =>
    block.type === "tool_call"
      ? [
          {
            id: block.id,
            name: block.name,
            input: block.input,
            raw: block.raw,
          },
        ]
      : [],
  );
}
