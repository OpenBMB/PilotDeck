import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";

export type ReadFileRangeResult = {
  content: string;
  /** Full file content (BOM-stripped). Available for snapshot hashing. */
  fullContent?: string;
  lineCount: number;
  totalLines: number;
  totalBytes: number;
  readBytes: number;
  mtimeMs: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
};

const UTF8_BOM = "\uFEFF";

export async function readFileInRange(
  filePath: string,
  startLine: number,
  limit?: number,
): Promise<ReadFileRangeResult> {
  const fileStat = await stat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PilotDeckToolRuntimeError("file_not_found", `File ${filePath} does not exist.`);
    }
    throw error;
  });
  if (!fileStat.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${filePath} is not a regular file.`);
  }

  if (limit !== undefined) {
    return readFileLineRange(filePath, fileStat, startLine, limit);
  }

  const buffer = await readFile(filePath);
  if (buffer.includes(0)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${filePath} appears to be a binary file.`);
  }

  const text = stripBom(buffer.toString("utf8"));
  const lines = text.split(/\r?\n/);
  const normalizedStart = Math.max(1, startLine);
  const startIndex = normalizedStart - 1;
  const normalizedLimit = limit === undefined ? undefined : Math.max(0, limit);
  const selected = normalizedLimit === undefined
    ? lines.slice(startIndex)
    : lines.slice(startIndex, startIndex + normalizedLimit);
  const content = selected.join("\n");
  const actualStart = selected.length > 0 ? normalizedStart : Math.min(normalizedStart, lines.length + 1);
  const actualEnd = selected.length > 0 ? actualStart + selected.length - 1 : actualStart - 1;

  return {
    content,
    fullContent: text,
    lineCount: selected.length,
    totalLines: lines.length,
    totalBytes: buffer.byteLength,
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: Math.floor(fileStat.mtimeMs),
    startLine: actualStart,
    endLine: actualEnd,
    truncated: startIndex > 0 || (normalizedLimit !== undefined && startIndex + normalizedLimit < lines.length),
  };
}

async function readFileLineRange(
  filePath: string,
  fileStat: Stats,
  startLine: number,
  limit: number,
): Promise<ReadFileRangeResult> {
  const normalizedStart = Math.max(1, startLine);
  const normalizedLimit = Math.max(0, limit);
  const startIndex = normalizedStart - 1;
  const endIndexExclusive = startIndex + normalizedLimit;
  const selected: string[] = [];
  let totalLines = 0;
  let sawNul = false;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  stream.on("data", (chunk: string | Buffer) => {
    if (String(chunk).includes("\0")) {
      sawNul = true;
      stream.destroy();
    }
  });

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      const line = totalLines === 0 ? stripBom(rawLine) : rawLine;
      if (totalLines >= startIndex && totalLines < endIndexExclusive) {
        selected.push(line);
      }
      totalLines += 1;
    }
  } catch (error) {
    if (!sawNul) throw error;
  }

  if (sawNul) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${filePath} appears to be a binary file.`);
  }

  const content = selected.join("\n");
  const actualStart = selected.length > 0 ? normalizedStart : Math.min(normalizedStart, totalLines + 1);
  const actualEnd = selected.length > 0 ? actualStart + selected.length - 1 : actualStart - 1;

  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes: fileStat.size,
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: Math.floor(fileStat.mtimeMs),
    startLine: actualStart,
    endLine: actualEnd,
    truncated: startIndex > 0 || endIndexExclusive < totalLines,
  };
}

function stripBom(value: string): string {
  return value.startsWith(UTF8_BOM) ? value.slice(1) : value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
