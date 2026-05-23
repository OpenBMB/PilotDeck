import path from "node:path";

const IMAGE_MIME = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const BINARY_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".bin",
  ".dat",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wav",
  ".ogg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

export type ParsedPdfPageRange = {
  firstPage: number;
  lastPage: number;
};

export function getPathExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function getImageMimeType(filePath: string): string | undefined {
  return IMAGE_MIME.get(getPathExtension(filePath));
}

export function isImagePath(filePath: string): boolean {
  return getImageMimeType(filePath) !== undefined;
}

export function isPdfPath(filePath: string): boolean {
  return getPathExtension(filePath) === ".pdf";
}

export function isNotebookPath(filePath: string): boolean {
  return getPathExtension(filePath) === ".ipynb";
}

export function hasBinaryExtension(filePath: string): boolean {
  const extension = getPathExtension(filePath);
  return BINARY_EXTENSIONS.has(extension) && !isImagePath(filePath) && !isPdfPath(filePath);
}

export function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) {
    return true;
  }
  return filePath.startsWith("/proc/")
    && (filePath.endsWith("/fd/0") || filePath.endsWith("/fd/1") || filePath.endsWith("/fd/2"));
}

export function parsePdfPageRange(value: string): ParsedPdfPageRange | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) {
    return undefined;
  }
  const firstPage = Number.parseInt(match[1]!, 10);
  const lastPage = Number.parseInt(match[2] ?? match[1]!, 10);
  if (firstPage < 1 || lastPage < firstPage) {
    return undefined;
  }
  return { firstPage, lastPage };
}

export async function countPdfPages(pdfBuffer: Buffer): Promise<number | undefined> {
  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
    const count = doc.countPages();
    return count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}
