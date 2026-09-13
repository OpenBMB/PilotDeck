import type { CanonicalMessage } from "../../model/index.js";

export function extractLastUserMessage(messages: CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    // Request-only date notices update the answering model, not the task
    // whose complexity determines the route.
    if (message.metadata?.synthetic === true && message.metadata?.purpose === "date_update") {
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
