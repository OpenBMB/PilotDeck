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
  options: { signal?: AbortSignal; maxConcurrency?: number } = {},
): Promise<MaterializeMediaReferencesResult> {
  options.signal?.throwIfAborted();
  const concurrency = options.maxConcurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Media concurrency must be a positive integer.");
  const cloned = cloneMessages(messages);
  const diagnostics: MediaReferenceMaterializationDiagnostic[] = [];
  const pending = cloned.flatMap(message => messageContent(message).map((block, index) => ({ message, block, index })));
  let next = 0;
  const reads = new Map<string, Promise<string>>();
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (next < pending.length) {
      options.signal?.throwIfAborted();
      const { message, block, index } = pending[next++];
      message.content[index] = await materializeBlock(block, diagnostics, options.signal, reads);
    }
  });
  await Promise.all(workers);
  options.signal?.throwIfAborted();

  return { messages: cloned, diagnostics };
}

async function materializeBlock(
  block: CanonicalContentBlock,
  diagnostics: MediaReferenceMaterializationDiagnostic[],
  signal: AbortSignal | undefined,
  reads: Map<string, Promise<string>>,
): Promise<CanonicalContentBlock> {
  if (block.type !== "media_reference") {
    return block;
  }

  try {
    signal?.throwIfAborted();
    let read = reads.get(block.path);
    if (!read) {
      read = readFile(block.path, { encoding: "utf8", signal });
      reads.set(block.path, read);
    }
    const data = await read;
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
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
