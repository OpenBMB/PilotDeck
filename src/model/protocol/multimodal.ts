import { ModelRequestError } from "./errors.js";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalToolResultContentBlock,
} from "./canonical.js";
import { messageContent } from "./clone.js";

export const SUPPORTED_INPUT_MODALITIES = ["text", "image", "pdf", "audio"] as const;

export type InputModality = (typeof SUPPORTED_INPUT_MODALITIES)[number];

export type MultimodalConstraints = {
  input: InputModality[];
  maxImagesPerRequest?: number;
  maxImageBytes?: number;
  supportedImageMimeTypes?: string[];
  maxPdfPages?: number;
  maxPdfBytes?: number;
  maxAudioSeconds?: number;
  imageDetail?: "auto" | "low" | "high";
};

export const DEFAULT_MULTIMODAL_CONSTRAINTS: MultimodalConstraints = {
  input: ["text"],
};

export function isInputModality(value: unknown): value is InputModality {
  return typeof value === "string" && SUPPORTED_INPUT_MODALITIES.includes(value as InputModality);
}

/**
 * Pre-flight downgrade: replace media blocks the target model cannot accept
 * with descriptive text placeholders.  Mutates `messages` in-place so the
 * caller's cloned request is updated without copying the entire array.
 *
 * Only tool_result sub-blocks and top-level content blocks are converted;
 * tool_call / thinking blocks are left untouched.
 */
export function downgradeUnsupportedContent(
  messages: CanonicalMessage[],
  constraints: MultimodalConstraints,
): void {
  const allowed = new Set<InputModality>(constraints.input);
  if (allowed.has("image") && allowed.has("pdf") && allowed.has("audio")) return;

  for (const msg of messages) {
    const content = messageContent(msg);
    for (let i = 0; i < content.length; i++) {
      const block = content[i]!;

      if (block.type === "tool_result") {
        let changed = false;
        const newContent: CanonicalToolResultContentBlock[] = [];
        for (const sub of block.content) {
          const placeholder = mediaBlockToPlaceholder(sub, allowed);
          if (placeholder) {
            newContent.push({ type: "text", text: placeholder });
            changed = true;
          } else {
            newContent.push(sub);
          }
        }
        if (changed) {
          (block as { content: CanonicalToolResultContentBlock[] }).content = newContent;
        }
        continue;
      }

      const placeholder = mediaBlockToPlaceholder(block, allowed);
      if (placeholder) {
        content[i] = { type: "text", text: placeholder };
      }
    }
  }
}

function mediaBlockToPlaceholder(
  block: CanonicalContentBlock | CanonicalToolResultContentBlock,
  allowed: Set<InputModality>,
): string | undefined {
  if (block.type === "image" && !allowed.has("image")) {
    const sizeHint = block.bytes ? `, ${Math.round(block.bytes / 1024)}KB` : "";
    return `[Image: ${block.mimeType}${sizeHint} — omitted, model does not support image input]`;
  }
  if (block.type === "pdf" && !allowed.has("pdf")) {
    const pagesHint = block.pages ? `, ${block.pages} pages` : "";
    return `[PDF: ${block.mimeType}, ${Math.round(block.bytes / 1024)}KB${pagesHint} — omitted, model does not support PDF input]`;
  }
  if (block.type === "audio" && !allowed.has("audio")) {
    return `[Audio: ${block.mimeType} — omitted, model does not support audio input]`;
  }
  return undefined;
}

export function contentBlockToInputModality(block: CanonicalContentBlock): InputModality | undefined {
  switch (block.type) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "pdf":
      return "pdf";
    case "audio":
      return "audio";
    case "thinking":
    case "tool_call":
    case "tool_result":
    case "tool_result_reference":
    case "media_reference":
      return undefined;
  }
}

function nestedToolResultModalities(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): InputModality[] {
  return block.content.flatMap((item) => {
    switch (item.type) {
      case "image":
        return ["image"];
      case "pdf":
        return ["pdf"];
      case "text":
        return [];
    }
  });
}

export function assertContentSupported(
  blocks: CanonicalContentBlock[],
  constraints: MultimodalConstraints,
): void {
  const allowed = new Set<InputModality>(constraints.input);
  let imageCount = 0;

  for (const block of blocks) {
    if (block.type === "tool_result") {
      const nested = nestedToolResultModalities(block);
      for (const modality of nested) {
        if (!allowed.has(modality)) {
          throw new ModelRequestError("unsupported_modality", `Model does not support ${modality} input.`, {
            modality,
          });
        }
      }
      for (const item of block.content) {
        if (item.type === "image") {
          imageCount += 1;
          if (
            constraints.supportedImageMimeTypes &&
            !constraints.supportedImageMimeTypes.includes(item.mimeType)
          ) {
            throw new ModelRequestError(
              "unsupported_image_mime_type",
              `Model does not support image MIME type ${item.mimeType}.`,
              { mimeType: item.mimeType },
            );
          }
          if (constraints.maxImageBytes && item.bytes && item.bytes > constraints.maxImageBytes) {
            throw new ModelRequestError("image_too_large", "Image content exceeds model limits.", {
              bytes: item.bytes,
              maxImageBytes: constraints.maxImageBytes,
            });
          }
        }
        if (item.type === "pdf" && constraints.maxPdfBytes && item.bytes > constraints.maxPdfBytes) {
          throw new ModelRequestError("pdf_too_large", "PDF content exceeds model limits.", {
            bytes: item.bytes,
            maxPdfBytes: constraints.maxPdfBytes,
          });
        }
      }
      continue;
    }

    const modality = contentBlockToInputModality(block);
    if (!modality) {
      continue;
    }

    if (!allowed.has(modality)) {
      throw new ModelRequestError("unsupported_modality", `Model does not support ${modality} input.`, {
        modality,
      });
    }

    if (block.type === "image") {
      imageCount += 1;

      if (
        constraints.supportedImageMimeTypes &&
        !constraints.supportedImageMimeTypes.includes(block.mimeType)
      ) {
        throw new ModelRequestError(
          "unsupported_image_mime_type",
          `Model does not support image MIME type ${block.mimeType}.`,
          { mimeType: block.mimeType },
        );
      }

      if (constraints.maxImageBytes && block.bytes && block.bytes > constraints.maxImageBytes) {
        throw new ModelRequestError("image_too_large", "Image content exceeds model limits.", {
          bytes: block.bytes,
          maxImageBytes: constraints.maxImageBytes,
        });
      }
    }

    if (block.type === "pdf" && constraints.maxPdfBytes && block.bytes > constraints.maxPdfBytes) {
      throw new ModelRequestError("pdf_too_large", "PDF content exceeds model limits.", {
        bytes: block.bytes,
        maxPdfBytes: constraints.maxPdfBytes,
      });
    }

    if (
      block.type === "audio" &&
      constraints.maxAudioSeconds &&
      block.durationSeconds &&
      block.durationSeconds > constraints.maxAudioSeconds
    ) {
      throw new ModelRequestError("audio_too_long", "Audio content exceeds model limits.", {
        durationSeconds: block.durationSeconds,
        maxAudioSeconds: constraints.maxAudioSeconds,
      });
    }
  }

  if (constraints.maxImagesPerRequest && imageCount > constraints.maxImagesPerRequest) {
    throw new ModelRequestError("too_many_images", "Image count exceeds model limits.", {
      imageCount,
      maxImagesPerRequest: constraints.maxImagesPerRequest,
    });
  }
}
