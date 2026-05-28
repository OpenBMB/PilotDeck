import type { CanonicalMessage } from "../../model/index.js";

export function extractLastUserMessage(messages: CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    const text = message.content
      .filter((block): block is import("../../model/index.js").CanonicalTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}
