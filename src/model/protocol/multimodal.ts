import { ModelRequestError } from "./errors.js";
import type { CanonicalContentBlock, CanonicalMessage, CanonicalToolResultContentBlock } from "./canonical.js";

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

export function sanitizeMessagesForMultimodalConstraints(
  messages: CanonicalMessage[],
  constraints: MultimodalConstraints | undefined,
): CanonicalMessage[] {
  if (!constraints) {
    return messages;
  }

  const state = {
    allowed: new Set<InputModality>(constraints.input),
    imageCount: 0,
  };

  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => sanitizeContentBlock(block, constraints, state)),
  }));
}

function sanitizeContentBlock(
  block: CanonicalContentBlock,
  constraints: MultimodalConstraints,
  state: { allowed: Set<InputModality>; imageCount: number },
): CanonicalContentBlock {
  if (block.type === "image") {
    state.imageCount += 1;
    return shouldStripImage(block, constraints, state)
      ? mediaPlaceholder("Image", "selected model does not support this image input")
      : block;
  }
  if (block.type === "pdf") {
    return shouldStripPdf(block, constraints, state)
      ? mediaPlaceholder("PDF", "selected model does not support this PDF input")
      : block;
  }
  if (block.type === "audio") {
    return shouldStripAudio(block, constraints, state)
      ? mediaPlaceholder("Audio", "selected model does not support this audio input")
      : block;
  }
  if (block.type === "tool_result") {
    return {
      ...block,
      content: block.content.map((item) => sanitizeToolResultContentBlock(item, constraints, state)),
    };
  }
  return block;
}

function sanitizeToolResultContentBlock(
  block: CanonicalToolResultContentBlock,
  constraints: MultimodalConstraints,
  state: { allowed: Set<InputModality>; imageCount: number },
): CanonicalToolResultContentBlock {
  if (block.type === "image") {
    state.imageCount += 1;
    return shouldStripImage(block, constraints, state)
      ? mediaPlaceholder("Image", "selected model does not support this image input")
      : block;
  }
  if (block.type === "pdf") {
    return shouldStripPdf(block, constraints, state)
      ? mediaPlaceholder("PDF", "selected model does not support this PDF input")
      : block;
  }
  return block;
}

function shouldStripImage(
  block: Extract<CanonicalContentBlock | CanonicalToolResultContentBlock, { type: "image" }>,
  constraints: MultimodalConstraints,
  state: { allowed: Set<InputModality>; imageCount: number },
): boolean {
  return !state.allowed.has("image") ||
    (constraints.supportedImageMimeTypes !== undefined && !constraints.supportedImageMimeTypes.includes(block.mimeType)) ||
    (constraints.maxImageBytes !== undefined && block.bytes !== undefined && block.bytes > constraints.maxImageBytes) ||
    (constraints.maxImagesPerRequest !== undefined && state.imageCount > constraints.maxImagesPerRequest);
}

function shouldStripPdf(
  block: Extract<CanonicalContentBlock | CanonicalToolResultContentBlock, { type: "pdf" }>,
  constraints: MultimodalConstraints,
  state: { allowed: Set<InputModality>; imageCount: number },
): boolean {
  return !state.allowed.has("pdf") ||
    (constraints.maxPdfBytes !== undefined && block.bytes > constraints.maxPdfBytes);
}

function shouldStripAudio(
  block: Extract<CanonicalContentBlock, { type: "audio" }>,
  constraints: MultimodalConstraints,
  state: { allowed: Set<InputModality>; imageCount: number },
): boolean {
  return !state.allowed.has("audio") ||
    (constraints.maxAudioSeconds !== undefined &&
      block.durationSeconds !== undefined &&
      block.durationSeconds > constraints.maxAudioSeconds);
}

function mediaPlaceholder(kind: "Image" | "PDF" | "Audio", reason: string): { type: "text"; text: string } {
  return { type: "text", text: `[${kind} removed: ${reason}.]` };
}
