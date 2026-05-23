import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readFileInRange } from "./filesystem/readFileInRange.js";
import {
  countPdfPages,
  getImageMimeType,
  hasBinaryExtension,
  isBlockedDevicePath,
  isImagePath,
  isNotebookPath,
  isPdfPath,
  parsePdfPageRange,
} from "./filesystem/fileTypeSafety.js";
import { readNotebook } from "./filesystem/readNotebook.js";
import { recordWriteSnapshot } from "./filesystem/writeSnapshots.js";
import { countTokens } from "../../context/budget/tokenizer.js";

export type ReadFileInput = {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_TOKENS = 25_000;
const MAX_PDF_PAGES_PER_REQUEST = 20;
const PDF_AT_MENTION_INLINE_THRESHOLD = 10;
const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024;
const FILE_UNCHANGED_STUB =
  "File unchanged since the last read. Refer to the earlier read_file result instead of re-reading it.";

export function createReadFileTool(): PilotDeckToolDefinition<ReadFileInput> {
  return {
    name: "read_file",
    aliases: ["Read"],
    description:
      "Reads a file from the current workspace. You can access workspace files directly by using this tool.\n"
      + "If the User provides a path to a file, assume that path is valid as long as it resolves inside the current workspace. "
      + "It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n"
      + "- The file_path parameter may be a workspace-relative path or an absolute path, but it must resolve inside the current workspace\n"
      + "- By default, offset is 1 and the tool reads from the beginning of the file\n"
      + "- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n"
      + "- Results are returned using cat -n format, with line numbers starting at 1\n"
      + "- This tool allows PilotDeck to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually when the current model supports image input\n"
      + "- This tool can read PDF files (.pdf). For large PDFs, provide the pages parameter to validate specific page ranges (e.g., pages: \"1-5\"). Maximum 20 pages per request\n"
      + "- This tool can read Jupyter notebooks (.ipynb files) and returns a text rendering of notebook cells and outputs\n"
      + "- This tool can only read files, not directories\n"
      + "- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description:
            "The relative or absolute path to the file to read. The path must resolve inside the current workspace.",
        },
        offset: {
          type: "integer",
          description:
            "The 1-based line number to start reading from. Only provide if the file is too large to read at once.",
        },
        limit: {
          type: "integer",
          description:
            "The number of lines to read. Only provide if the file is too large to read at once.",
        },
        pages: {
          type: "string",
          description:
            "Page range for PDF files (e.g., \"1-5\", \"3\", \"10-20\"). Only applicable to PDF files. Maximum 20 pages per request.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput: async (input, context) => {
      if (input.offset !== undefined && input.offset < 1) {
        return {
          ok: false,
          issues: [{ path: "offset", code: "invalid_schema", message: "offset must be a 1-based line number (>= 1)." }],
        };
      }
      if (input.limit !== undefined && input.limit < 0) {
        return {
          ok: false,
          issues: [{ path: "limit", code: "invalid_schema", message: "limit must be greater than or equal to 0." }],
        };
      }
      if (input.pages !== undefined) {
        const parsed = parsePdfPageRange(input.pages);
        if (!parsed) {
          return {
            ok: false,
            issues: [{ path: "pages", code: "invalid_schema", message: "pages must use formats like \"1-5\" or \"3\"." }],
          };
        }
        if (parsed.lastPage - parsed.firstPage + 1 > MAX_PDF_PAGES_PER_REQUEST) {
          return {
            ok: false,
            issues: [{
              path: "pages",
              code: "invalid_schema",
              message: `pages exceeds the maximum of ${MAX_PDF_PAGES_PER_REQUEST} pages per request.`,
            }],
          };
        }
      }

      const absolutePath = path.resolve(
        path.isAbsolute(input.file_path) ? input.file_path : path.join(context.cwd, input.file_path),
      );
      if (isBlockedDevicePath(absolutePath)) {
        return {
          ok: false,
          issues: [{ path: "file_path", code: "invalid_schema", message: "device files that block or stream infinitely are not readable." }],
        };
      }
      if (hasBinaryExtension(absolutePath)) {
        return {
          ok: false,
          issues: [{ path: "file_path", code: "invalid_schema", message: "binary files are not supported by read_file." }],
        };
      }
      return { ok: true, input };
    },
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, { mustExist: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const fileStat = await stat(resolved.absolutePath);
      const kind = classifyReadKind(resolved.absolutePath);
      const readState = context.readFileState ?? (context.readFileState = new Map());
      const dedupKey = buildReadStateKey(resolved.absolutePath, kind, input.offset, input.limit, input.pages);
      const previous = readState.get(dedupKey);
      if (previous && previous.mtimeMs === Math.floor(fileStat.mtimeMs)) {
        return {
          content: [{ type: "text", text: FILE_UNCHANGED_STUB }],
          data: {
            filePath: resolved.relativePath,
            kind,
            unchanged: true,
          },
          metadata: { unchanged: true },
        };
      }

      if (kind === "image") {
        const mimeType = getImageMimeType(resolved.absolutePath);
        if (!mimeType) {
          throw new PilotDeckToolRuntimeError("invalid_tool_input", `Unsupported image type: ${resolved.relativePath}.`);
        }
        const supportsImage = context.modelMultimodal?.input?.includes("image");
        if (!supportsImage) {
          return {
            content: [{
              type: "text",
              text: `[Image file: ${resolved.relativePath}, ${fileStat.size} bytes, ${mimeType}. Current model does not support image input.]`,
            }],
            data: { filePath: resolved.relativePath, kind, modelSupportsImage: false },
          };
        }
        const imageBuffer = await readFile(resolved.absolutePath);
        const validated = await validateAndRepairImage(imageBuffer, mimeType);
        const maxImageBytes = Math.min(MAX_IMAGE_BYTES, context.modelMultimodal?.maxImageBytes ?? MAX_IMAGE_BYTES);
        const compressed = await compressImageForBudget(validated.buffer, validated.mimeType, maxImageBytes);
        readState.set(dedupKey, {
          mtimeMs: Math.floor(fileStat.mtimeMs),
          kind,
          offset: input.offset,
          limit: input.limit,
          pages: input.pages,
        });
        return {
          content: [{
            type: "image",
            mimeType: compressed.mimeType,
            data: compressed.buffer.toString("base64"),
            bytes: compressed.buffer.byteLength,
            detail: context.modelMultimodal?.imageDetail,
          }],
          data: {
            filePath: resolved.relativePath,
            kind,
            mimeType: compressed.mimeType,
            bytes: compressed.buffer.byteLength,
            originalBytes: imageBuffer.byteLength,
          },
        };
      }

      if (kind === "pdf") {
        const supportsPdf = context.modelMultimodal?.input?.includes("pdf");
        const supportsImage = context.modelMultimodal?.input?.includes("image");
        const parsedPages = input.pages ? parsePdfPageRange(input.pages) : undefined;
        if (input.pages && !parsedPages) {
          throw new PilotDeckToolRuntimeError("invalid_tool_input", `Invalid PDF page range: ${input.pages}.`);
        }

        const pdfBuffer = await readFile(resolved.absolutePath);
        const pageCount = await countPdfPages(pdfBuffer);

        if (
          parsedPages
          && pageCount !== undefined
          && parsedPages.lastPage > pageCount
        ) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `PDF page range ${input.pages} exceeds the detected page count (${pageCount}).`,
          );
        }

        // With pages parameter: always render as images via mupdf
        if (parsedPages) {
          if (!supportsImage) {
            return {
              content: [{
                type: "text",
                text: `[PDF file: ${resolved.relativePath}, ${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""}. Current model does not support image input; cannot render requested pages.]`,
              }],
              data: { filePath: resolved.relativePath, kind, modelSupportsImage: false, pageCount },
            };
          }
          const rendered = await renderPdfPagesAsImages(
            pdfBuffer,
            resolved.relativePath,
            parsedPages,
            pageCount,
            context.modelMultimodal?.maxImageBytes ?? MAX_IMAGE_BYTES,
            context.modelMultimodal?.imageDetail,
          );
          if (!rendered.ok) {
            return {
              content: [{
                type: "text",
                text: `[PDF file: ${resolved.relativePath}. PDF page rendering failed: ${rendered.error}]`,
              }],
              data: { filePath: resolved.relativePath, kind, pageCount, renderError: rendered.error },
            };
          }
          readState.set(dedupKey, {
            mtimeMs: Math.floor(fileStat.mtimeMs),
            kind,
            offset: input.offset,
            limit: input.limit,
            pages: input.pages,
          });
          return {
            content: [{
              type: "text" as const,
              text: `PDF pages extracted: ${rendered.lastPage - rendered.firstPage + 1} page(s) from ${resolved.relativePath} (pages ${rendered.firstPage}-${rendered.lastPage}${pageCount ? ` of ${pageCount}` : ""}).`,
            }],
            supplementalMessages: [{
              role: "user",
              content: rendered.images,
              isMeta: true,
            }],
            data: {
              filePath: resolved.relativePath,
              kind,
              pdfPagesRendered: true,
              pageCount,
              requestedPages: input.pages,
              renderedPages: { firstPage: rendered.firstPage, lastPage: rendered.lastPage },
              truncated: rendered.truncated,
            },
            metadata: { truncated: rendered.truncated },
          };
        }

        // Without pages: enforce page count threshold
        if (pageCount !== undefined && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `This PDF has ${pageCount} pages, which is too many to read at once. ` +
            `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
            `Maximum ${MAX_PDF_PAGES_PER_REQUEST} pages per request.`,
          );
        }

        // Degrade to image rendering when model lacks PDF support or file is large
        if (!supportsPdf || fileStat.size > PDF_EXTRACT_SIZE_THRESHOLD) {
          if (!supportsImage) {
            return {
              content: [{
                type: "text",
                text: `[PDF file: ${resolved.relativePath}, ${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""}. Current model does not support PDF input or image input.]`,
              }],
              data: { filePath: resolved.relativePath, kind, modelSupportsPdf: false, modelSupportsImage: false, pageCount },
            };
          }
          const rendered = await renderPdfPagesAsImages(
            pdfBuffer,
            resolved.relativePath,
            undefined,
            pageCount,
            context.modelMultimodal?.maxImageBytes ?? MAX_IMAGE_BYTES,
            context.modelMultimodal?.imageDetail,
          );
          if (rendered.ok) {
            readState.set(dedupKey, {
              mtimeMs: Math.floor(fileStat.mtimeMs),
              kind,
              offset: input.offset,
              limit: input.limit,
              pages: input.pages,
            });
            const degradeReason = !supportsPdf ? "model does not support PDF input" : `file exceeds ${PDF_EXTRACT_SIZE_THRESHOLD / 1024 / 1024}MB threshold`;
            return {
              content: [{
                type: "text" as const,
                text: `[PDF pages rendered from ${resolved.relativePath}: ${rendered.firstPage}-${rendered.lastPage}${pageCount ? ` of ${pageCount}` : ""} (${degradeReason}).]`
                  + (rendered.truncated ? `\n[PDF truncated to ${MAX_PDF_PAGES_PER_REQUEST} pages; use the pages parameter to read another range.]` : ""),
              }],
              supplementalMessages: [{
                role: "user",
                content: rendered.images,
                isMeta: true,
              }],
              data: {
                filePath: resolved.relativePath,
                kind,
                modelSupportsPdf: !!supportsPdf,
                pdfPagesRendered: true,
                degradeReason,
                pageCount,
                renderedPages: { firstPage: rendered.firstPage, lastPage: rendered.lastPage },
                truncated: rendered.truncated,
              },
              metadata: { truncated: rendered.truncated },
            };
          }
          return {
            content: [{
              type: "text",
              text: `[PDF file: ${resolved.relativePath}, ${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""}. PDF page rendering failed: ${rendered.error}]`,
            }],
            data: { filePath: resolved.relativePath, kind, modelSupportsPdf: !!supportsPdf, pageCount, renderError: rendered.error },
          };
        }

        // Model supports PDF and file is small enough: send as document block
        readState.set(dedupKey, {
          mtimeMs: Math.floor(fileStat.mtimeMs),
          kind,
          offset: input.offset,
          limit: input.limit,
          pages: input.pages,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `PDF file read: ${resolved.relativePath} (${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""})`,
            },
          ],
          supplementalMessages: [{
            role: "user",
            content: [
              {
                type: "pdf" as const,
                mimeType: "application/pdf" as const,
                data: pdfBuffer.toString("base64"),
                bytes: pdfBuffer.byteLength,
                pages: pageCount,
              },
            ],
            isMeta: true,
          }],
          data: {
            filePath: resolved.relativePath,
            kind,
            bytes: pdfBuffer.byteLength,
            pageCount,
          },
        };
      }

      const offset = input.offset ?? 1;
      if (kind === "notebook") {
        const notebook = await readNotebook(resolved.absolutePath);
        const ranged = sliceRenderedText(notebook.text, offset, input.limit);
        const numbered = renderNumberedLines(ranged.lines, ranged.startLine);
        ensureTokenBudget(numbered, resolved.relativePath);
        readState.set(dedupKey, {
          mtimeMs: Math.floor(fileStat.mtimeMs),
          kind,
          offset: input.offset,
          limit: input.limit,
          pages: input.pages,
        });
        if (offset === 1 && input.limit === undefined) {
          recordWriteSnapshot(context, resolved.absolutePath, await readFile(resolved.absolutePath, "utf8"), fileStat.mtimeMs);
        }
        return {
          content: [{ type: "text", text: numbered }],
          data: {
            filePath: resolved.relativePath,
            kind,
            startLine: ranged.startLine,
            endLine: ranged.endLine,
            totalLines: ranged.totalLines,
            truncated: ranged.truncated,
            cellCount: notebook.cellCount,
          },
          metadata: { truncated: ranged.truncated },
        };
      }

      const ranged = await readFileInRange(resolved.absolutePath, offset, input.limit);
      const text = renderReadableRange(ranged.content, ranged.startLine, ranged.totalLines);
      ensureTokenBudget(text, resolved.relativePath);
      readState.set(dedupKey, {
        mtimeMs: ranged.mtimeMs,
        kind,
        offset: input.offset,
        limit: input.limit,
        pages: input.pages,
      });
      if (offset === 1 && input.limit === undefined) {
        recordWriteSnapshot(context, resolved.absolutePath, ranged.content, ranged.mtimeMs);
      }
      return {
        content: [{ type: "text", text }],
        data: {
          filePath: resolved.relativePath,
          kind,
          startLine: ranged.startLine,
          endLine: ranged.endLine,
          totalLines: ranged.totalLines,
          truncated: ranged.truncated,
        },
        metadata: { truncated: ranged.truncated },
      };
    },
  };
}
function classifyReadKind(filePath: string): "text" | "image" | "pdf" | "notebook" {
  if (isImagePath(filePath)) {
    return "image";
  }
  if (isPdfPath(filePath)) {
    return "pdf";
  }
  if (isNotebookPath(filePath)) {
    return "notebook";
  }
  return "text";
}

function buildReadStateKey(
  filePath: string,
  kind: "text" | "image" | "pdf" | "notebook",
  offset?: number,
  limit?: number,
  pages?: string,
): string {
  return `${filePath}::${kind}::${offset ?? 1}::${limit ?? "all"}::${pages ?? ""}`;
}

function renderReadableRange(content: string, startLine: number, totalLines: number): string {
  if (content.length > 0) {
    return renderNumberedLines(content.split("\n"), startLine);
  }
  if (totalLines === 0) {
    return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
  }
  return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.</system-reminder>`;
}

function renderNumberedLines(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}|${line}`).join("\n");
}

async function renderPdfPagesAsImages(
  pdfBuffer: Buffer,
  relativePath: string,
  pages: { firstPage: number; lastPage: number } | undefined,
  pageCount: number | undefined,
  maxImageBytes: number,
  imageDetail: "auto" | "low" | "high" | undefined,
): Promise<{
  ok: true;
  images: Array<{
    type: "image";
    mimeType: string;
    data: string;
    bytes: number;
    detail?: "auto" | "low" | "high";
  }>;
  firstPage: number;
  lastPage: number;
  truncated: boolean;
} | {
  ok: false;
  error: string;
}> {
  const firstPage = pages?.firstPage ?? 1;
  const lastPage = pages?.lastPage ?? Math.min(pageCount ?? MAX_PDF_PAGES_PER_REQUEST, MAX_PDF_PAGES_PER_REQUEST);
  const truncated = pages === undefined && pageCount !== undefined && pageCount > lastPage;

  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");

    const images = [];
    for (let i = firstPage - 1; i < lastPage; i++) {
      const page = doc.loadPage(i);
      const scale = 100 / 72;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      const jpegData = pixmap.asJPEG(80, false);
      const jpegBuffer = Buffer.from(jpegData);

      const compressed = await compressImageForBudget(
        jpegBuffer,
        "image/jpeg",
        Math.min(MAX_IMAGE_BYTES, maxImageBytes),
      );
      images.push({
        type: "image" as const,
        mimeType: compressed.mimeType,
        data: compressed.buffer.toString("base64"),
        bytes: compressed.buffer.byteLength,
        ...(imageDetail ? { detail: imageDetail } : {}),
      });
    }

    if (images.length === 0) {
      return { ok: false, error: `mupdf produced no page images for ${relativePath}` };
    }

    return {
      ok: true,
      images,
      firstPage,
      lastPage,
      truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message || "mupdf rendering failed" };
  }
}

function sliceRenderedText(
  text: string,
  startLine: number,
  limit?: number,
): { lines: string[]; startLine: number; endLine: number; totalLines: number; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const startIndex = Math.max(0, startLine - 1);
  const selected = limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit);
  const actualStart = selected.length > 0 ? startLine : Math.min(startLine, lines.length + 1);
  const actualEnd = selected.length > 0 ? actualStart + selected.length - 1 : actualStart - 1;
  return {
    lines: selected,
    startLine: actualStart,
    endLine: actualEnd,
    totalLines: lines.length,
    truncated: startIndex > 0 || (limit !== undefined && startIndex + limit < lines.length),
  };
}

function ensureTokenBudget(text: string, filePath: string): void {
  if (countTokens(text) > MAX_TEXT_TOKENS) {
    throw new PilotDeckToolRuntimeError(
      "result_too_large",
      `File content from ${filePath} exceeds the text token budget. Use offset and limit to read a smaller portion.`,
    );
  }
}

/**
 * Validate image integrity and attempt repair if truncated/corrupted.
 * Fast path: complete JPEGs (with EOI marker and > 1KB) pass through unchanged.
 * For suspicious images, attempt re-encode via sharp which can tolerate minor truncation.
 * Throws PilotDeckToolRuntimeError if the image is unrecoverably corrupt.
 */
async function validateAndRepairImage(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const isJpeg = mimeType === "image/jpeg";
  const hasEoi = isJpeg && buffer.length >= 2
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;

  if (isJpeg && hasEoi && buffer.length > 1000) {
    return { buffer, mimeType };
  }

  if (!isJpeg && buffer.length > 1000) {
    // For non-JPEG formats, do a quick decode check via sharp
    try {
      const sharpModule = await import("sharp");
      const sharp = sharpModule.default;
      await sharp(buffer).metadata();
      return { buffer, mimeType };
    } catch {
      // Fall through to repair attempt
    }
  }

  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const repaired = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    return { buffer: repaired, mimeType: "image/jpeg" };
  } catch {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Image file appears truncated or corrupted (${buffer.length} bytes). Cannot decode.`,
    );
  }
}

/**
 * Multi-pass image compressor. We size against a single byte budget (which
 * the model's own `maxImageBytes` constraint also enforces) — there's no
 * separate "image token" cap because multimodal LLMs price images by
 * dimensions or fixed tile cost, not by base64 length. A `bytes / 6`
 * heuristic on top of that just rejects perfectly cheap images (e.g. a
 * 250 KB JPEG that Claude charges ~700 tokens for).
 *
 * Cascade: pass 1 = format-appropriate 1600px / quality 80, pass 2 =
 * 1200px JPEG quality 55, pass 3 = 800px JPEG quality 40. Only after all
 * three fail to fit do we surface `result_too_large`.
 */
async function compressImageForBudget(
  buffer: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let output = buffer;
  let outputMimeType = mimeType;
  if (output.byteLength > maxBytes) {
    try {
      const sharpModule = await import("sharp");
      const sharp = sharpModule.default;
      const pipeline = sharp(buffer).rotate();
      if (mimeType === "image/png") {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        outputMimeType = "image/png";
      } else if (mimeType === "image/webp") {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        outputMimeType = "image/webp";
      } else if (mimeType === "image/gif") {
        output = await pipeline
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        outputMimeType = "image/png";
      } else {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }

      if (output.byteLength > maxBytes) {
        output = await sharp(output)
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 55 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }

      if (output.byteLength > maxBytes) {
        output = await sharp(output)
          .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 40 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }
    } catch {
      // Fall back to the original bytes when image compression is unavailable.
    }
  }

  if (output.byteLength > maxBytes) {
    throw new PilotDeckToolRuntimeError(
      "result_too_large",
      `Image content exceeds the read_file byte budget after compression attempts (${mimeType}).`,
      { mimeType: outputMimeType, bytes: output.byteLength, maxBytes },
    );
  }
  return { buffer: output, mimeType: outputMimeType };
}
