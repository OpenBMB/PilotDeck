import type {
  CanonicalContentBlock,
  CanonicalMessage,
} from "../../model/index.js";
import type { InputModality, MultimodalConstraints } from "../../model/index.js";

const MEDIA_MODALITY_ORDER: InputModality[] = ["image", "pdf", "audio", "video"];

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

export function missingInputModalities(
  constraints: MultimodalConstraints,
  required: readonly InputModality[],
): InputModality[] {
  if (required.length === 0) {
    return [];
  }
  const supported = new Set<InputModality>(constraints.input);
  return required.filter((modality) => !supported.has(modality));
}

export function supportsRequiredModalities(
  constraints: MultimodalConstraints,
  required: readonly InputModality[],
): boolean {
  return missingInputModalities(constraints, required).length === 0;
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
    case "video":
      required.add("video");
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
