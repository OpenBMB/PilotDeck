import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";

export type AttachmentRequest =
  | { type: "file"; path: string }
  | { type: "image"; path: string; mimeType?: string }
  | { type: "pdf"; path: string };

export type ResolvedAttachment = {
  blocks: CanonicalContentBlock[];
  diagnostics: Array<{
    code:
      | "attachment_missing"
      | "attachment_too_large"
      | "attachment_unsupported"
      | "image_invalid"
      | "image_no_resize"
      | "pdf_size_estimate";
    severity: "info" | "warning" | "error";
    message: string;
  }>;
};

export type AttachmentResolverOptions = {
  /** Maximum bytes per attachment (file). Larger files are rejected. */
  maxFileBytes?: number;
  /** Maximum image bytes after base64 decode (legacy: 5 MiB). */
  maxImageBytes?: number;
  /** Approximate bytes-per-page for PDF estimation (legacy fallback: 102_400). */
  bytesPerPdfPage?: number;
};

const DEFAULT_MAX_FILE_BYTES = 1_000_000; // 1 MB
const DEFAULT_MAX_IMAGE_BYTES = 5_242_880; // 5 MiB (legacy)
const DEFAULT_BYTES_PER_PDF_PAGE = 102_400; // 100 KB (legacy fallback)

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".yaml", ".yml", ".ts", ".tsx", ".js", ".tsx", ".log"]);
const IMAGE_MIME = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export class AttachmentResolver {
  private readonly maxFileBytes: number;
  private readonly maxImageBytes: number;
  private readonly bytesPerPdfPage: number;

  constructor(options: AttachmentResolverOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.bytesPerPdfPage = options.bytesPerPdfPage ?? DEFAULT_BYTES_PER_PDF_PAGE;
  }

  async resolve(request: AttachmentRequest): Promise<ResolvedAttachment> {
    switch (request.type) {
      case "file":
        return this.resolveFile(request.path);
      case "image":
        return this.resolveImage(request.path, request.mimeType);
      case "pdf":
        return this.resolvePdf(request.path);
    }
  }

  async resolveAll(requests: AttachmentRequest[]): Promise<ResolvedAttachment> {
    const blocks: CanonicalContentBlock[] = [];
    const diagnostics: ResolvedAttachment["diagnostics"] = [];
    for (const request of requests) {
      const result = await this.resolve(request);
      blocks.push(...result.blocks);
      diagnostics.push(...result.diagnostics);
    }
    return { blocks, diagnostics };
  }

  toUserMessage(attachment: ResolvedAttachment): CanonicalMessage {
    return { role: "user", content: attachment.blocks };
  }

  private async resolveFile(path: string): Promise<ResolvedAttachment> {
    const absolute = resolve(path);
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_missing",
            severity: "warning",
            message: `Attachment not found: ${absolute} (${error instanceof Error ? error.message : String(error)}).`,
          },
        ],
      };
    }
    if (info.size > this.maxFileBytes) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_too_large",
            severity: "warning",
            message: `Attachment ${absolute} is ${info.size} bytes (limit ${this.maxFileBytes}); skipped.`,
          },
        ],
      };
    }
    const ext = extname(absolute).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_unsupported",
            severity: "info",
            message: `File extension ${ext || "(none)"} not in text whitelist; skipped (use a more specific resolver).`,
          },
        ],
      };
    }
    const text = await readFile(absolute, "utf8");
    return {
      blocks: [
        { type: "text", text: `<attachment path="${absolute}">\n${text}\n</attachment>` },
      ],
      diagnostics: [],
    };
  }

  private async resolveImage(path: string, mimeType?: string): Promise<ResolvedAttachment> {
    const absolute = resolve(path);
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_missing",
            severity: "warning",
            message: `Image attachment not found: ${absolute} (${error instanceof Error ? error.message : String(error)}).`,
          },
        ],
      };
    }
    if (info.size > this.maxImageBytes) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_too_large",
            severity: "warning",
            message: `Image ${absolute} is ${info.size} bytes (limit ${this.maxImageBytes}); skipped (PilotDeck does not resize, intentional_difference §4.5).`,
          },
        ],
      };
    }
    const ext = extname(absolute).toLowerCase();
    const detectedMime = mimeType ?? IMAGE_MIME.get(ext);
    if (!detectedMime) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_unsupported",
            severity: "warning",
            message: `Cannot determine image mime type from ${absolute}; provide mimeType explicitly.`,
          },
        ],
      };
    }
    const buffer = await readFile(absolute);
    const actualMime = detectImageMime(buffer);
    if (!actualMime) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "image_invalid",
            severity: "warning",
            message: `Image ${absolute} could not be identified from its bytes; skipped and left as a local path diagnostic.`,
          },
        ],
      };
    }
    if (!imageMimeCompatible(detectedMime, actualMime)) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "image_invalid",
            severity: "warning",
            message: `Image ${absolute} was declared as ${detectedMime} but bytes look like ${actualMime}; skipped and left as a local path diagnostic.`,
          },
        ],
      };
    }
    return {
      blocks: [
        {
          type: "image",
          source: "base64",
          data: buffer.toString("base64"),
          mimeType: detectedMime,
          bytes: info.size,
        },
      ],
      diagnostics: [
        {
          code: "image_no_resize",
          severity: "info",
          message: "PilotDeck does not resize images; original bytes forwarded (intentional_difference §4.5).",
        },
      ],
    };
  }

  private async resolvePdf(path: string): Promise<ResolvedAttachment> {
    const absolute = resolve(path);
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      return {
        blocks: [],
        diagnostics: [
          {
            code: "attachment_missing",
            severity: "warning",
            message: `PDF attachment not found: ${absolute} (${error instanceof Error ? error.message : String(error)}).`,
          },
        ],
      };
    }
    const estimatedPages = Math.max(1, Math.round(info.size / this.bytesPerPdfPage));
    return {
      blocks: [
        {
          type: "text",
          text: `[PDF attachment: ${absolute}, ${info.size} bytes, estimated ${estimatedPages} pages. Use read_file on this registered attachment path to inspect it.]`,
        },
      ],
      diagnostics: [
        {
          code: "pdf_size_estimate",
          severity: "info",
          message: `Estimated ${estimatedPages} pages from ${info.size} bytes (PilotDeck does not invoke pdfinfo, intentional_difference §4.5).`,
        },
      ],
    };
  }
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function imageMimeCompatible(declared: string, actual: string): boolean {
  return declared.toLowerCase() === actual.toLowerCase();
}
