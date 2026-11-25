import type {
  CanonicalContentBlock,
  CanonicalMessage,
} from "../../model/index.js";
import type { InputModality } from "../../model/index.js";

const MEDIA_MODALITY_ORDER: InputModality[] = ["image", "pdf", "audio"];

export function collectRequiredInputModalities(
  messages: CanonicalMessage[],
): InputModality[] {
  const required = new Set<InputModality>();

  for (const message of messages) {
    for (const block of message.content) {
      collectFromBlock(block, required);
    }
  }

  return MEDIA_MODALITY_ORDER.filter((modality) => required.has(modality));
}

function collectFromBlock(
  block: CanonicalContentBlock,
  required: Set<InputModality>,
): void {
  switch (block.type) {
    case "image":
      required.add("image");
      return;
    case "pdf":
      required.add("pdf");
      return;
    case "audio":
      required.add("audio");
      return;
    case "tool_result":
      for (const item of block.content) {
        if (item.type === "image" || item.type === "pdf") {
          required.add(item.type);
        }
      }
      return;
    case "text":
    case "thinking":
    case "tool_call":
    case "tool_result_reference":
      return;
  }
}
