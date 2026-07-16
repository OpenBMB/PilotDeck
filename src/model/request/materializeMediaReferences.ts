import { readFile } from "node:fs/promises";
import type {
  CanonicalContentBlock,
  CanonicalMediaReferenceBlock,
  CanonicalMessage,
} from "../protocol/canonical.js";
import { cloneMessages, messageContent } from "../protocol/clone.js";

export type MediaReferenceMaterializationDiagnostic = {
  code:
    | "media_reference_invalid_pdf_mime"
    | "media_reference_materialization_failed"
    | "media_reference_unsupported_type";
  path: string;
  mediaType: string;
  message: string;
};

export type MaterializeMediaReferencesResult = {
  messages: CanonicalMessage[];
  diagnostics: MediaReferenceMaterializationDiagnostic[];
};

export async function materializeMediaReferences(
  messages: CanonicalMessage[],
): Promise<MaterializeMediaReferencesResult> {
  const cloned = cloneMessages(messages);
  const diagnostics: MediaReferenceMaterializationDiagnostic[] = [];

  await Promise.all(
    cloned.map(async (message) => {
      const content = await Promise.all(
        messageContent(message).map((block) => materializeBlock(block, diagnostics)),
      );
      message.content = content;
    }),
  );

  return { messages: cloned, diagnostics };
}

async function materializeBlock(
  block: CanonicalContentBlock,
  diagnostics: MediaReferenceMaterializationDiagnostic[],
): Promise<CanonicalContentBlock> {
  if (block.type !== "media_reference") {
    return block;
  }

  try {
    const data = await readFile(block.path, "utf8");
    const materialized = toMediaBlock(block, data);
    if (!materialized) {
      diagnostics.push({
        code: "media_reference_unsupported_type",
        path: block.path,
        mediaType: block.mediaType,
        message: `Unsupported media reference type: ${block.mediaType}`,
      });
      return fallbackText(block);
    }
    return materialized;
  } catch (error) {
    diagnostics.push({
      code: "media_reference_materialization_failed",
      path: block.path,
      mediaType: block.mediaType,
      message: error instanceof Error ? error.message : String(error),
    });
    return fallbackText(block);
  }
}

function toMediaBlock(
  block: CanonicalMediaReferenceBlock,
  data: string,
): CanonicalContentBlock | undefined {
  if (block.mediaType === "image") {
    return {
      type: "image",
      source: "base64",
      data,
      mimeType: block.mimeType,
      bytes: block.originalBytes,
      ...(block.detail ? { detail: block.detail } : {}),
    };
  }

  if (block.mediaType === "pdf") {
    if (block.mimeType !== "application/pdf") {
      return undefined;
    }
    return {
      type: "pdf",
      source: "base64",
      data,
      mimeType: "application/pdf",
      bytes: block.originalBytes,
      ...(block.pages !== undefined ? { pages: block.pages } : {}),
    };
  }

  if (block.mediaType === "audio") {
    return {
      type: "audio",
      source: "base64",
      data,
      mimeType: block.mimeType,
      bytes: block.originalBytes,
    };
  }

  return undefined;
}

function fallbackText(block: CanonicalMediaReferenceBlock): CanonicalContentBlock {
  return {
    type: "text",
    text: block.preview,
  };
}
