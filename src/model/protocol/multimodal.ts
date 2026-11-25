import { ModelRequestError } from "./errors.js";
import type {
  CanonicalContentBlock,
  CanonicalImageBlock,
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
  imageQuotaOnly = false,
): { changed: boolean; omittedImages: number } {
  const allowed = new Set<InputModality>(constraints.input);
  let changed = false;
  let omittedImages = 0;
  let imageCount = 0;
  const placeholderFor = (block: CanonicalContentBlock | CanonicalToolResultContentBlock): string | undefined => {
    if (block.type !== "image") return imageQuotaOnly ? undefined : mediaBlockToPlaceholder(block, allowed);
    const error = imageInputError(block, constraints, imageCount + 1);
    if (!error) {
      imageCount++;
      return undefined;
    }
    if (imageQuotaOnly && error.code !== "too_many_images") return undefined;
    omittedImages++;
    const sizeHint = block.bytes ? `, ${Math.round(block.bytes / 1024)}KB` : "";
    return `[Image: ${block.mimeType}${sizeHint} — omitted, ${error.message}]`;
  };

  // Reserve the quota for recent messages first, keeping their order on the wire.
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const msg = messages[messageIndex]!;
    const content = messageContent(msg);
    for (let i = 0; i < content.length; i++) {
      const block = content[i]!;

      if (block.type === "tool_result") {
        let blockChanged = false;
        const newContent: CanonicalToolResultContentBlock[] = [];
        for (const sub of block.content) {
          const placeholder = placeholderFor(sub);
          if (placeholder) {
            newContent.push({ type: "text", text: placeholder });
            blockChanged = true;
          } else {
            newContent.push(sub);
          }
        }
        if (blockChanged) {
          block.content = newContent;
          changed = true;
        }
        continue;
      }

      const placeholder = placeholderFor(block);
      if (placeholder) {
        content[i] = { type: "text", text: placeholder };
        changed = true;
      }
    }
  }
  return { changed, omittedImages };
}

function mediaBlockToPlaceholder(
  block: CanonicalContentBlock | CanonicalToolResultContentBlock,
  allowed: Set<InputModality>,
): string | undefined {
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

export type MediaValidationOptions = {
  allowImageResize?: boolean;
  allowImageCountOverflow?: boolean;
};

export function assertContentSupported(
  blocks: CanonicalContentBlock[],
  constraints: MultimodalConstraints,
  options?: MediaValidationOptions,
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
          const error = imageInputError(item, constraints, ++imageCount, options);
          if (error) throw error;
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
      const error = imageInputError(block, constraints, ++imageCount, options);
      if (error) throw error;
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
}

function imageInputError(
  image: CanonicalImageBlock,
  constraints: MultimodalConstraints,
  imageCount: number,
  options?: MediaValidationOptions,
): ModelRequestError | undefined {
  if (!constraints.input.includes("image")) {
    return new ModelRequestError("unsupported_modality", "Model does not support image input.", { modality: "image" });
  }
  if (constraints.supportedImageMimeTypes && !constraints.supportedImageMimeTypes.includes(image.mimeType)) {
    return new ModelRequestError("unsupported_image_mime_type", `Model does not support image MIME type ${image.mimeType}.`, {
      mimeType: image.mimeType,
    });
  }
  if (constraints.maxImageBytes && image.bytes && image.bytes > constraints.maxImageBytes
    && !(options?.allowImageResize && image.source === "base64" && image.data)) {
    return new ModelRequestError("image_too_large", "Image content exceeds model limits.", {
      bytes: image.bytes,
      maxImageBytes: constraints.maxImageBytes,
    });
  }
  if (!options?.allowImageCountOverflow && constraints.maxImagesPerRequest && imageCount > constraints.maxImagesPerRequest) {
    return new ModelRequestError("too_many_images", "Image count exceeds model limits.", {
      imageCount,
      maxImagesPerRequest: constraints.maxImagesPerRequest,
    });
  }
  return undefined;
}
