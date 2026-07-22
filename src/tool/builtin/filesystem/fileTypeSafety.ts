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
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".key",
  ".numbers",
  ".rp",
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
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlt",
  ".xltx",
  ".xltm",
  ".doc",
  ".docx",
  ".docm",
  ".dot",
  ".dotx",
  ".dotm",
  ".ppt",
  ".pptx",
  ".pptm",
  ".pot",
  ".potx",
  ".potm",
  ".pps",
  ".ppsx",
  ".ppsm",
  ".odt",
  ".ods",
  ".odp",
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

const WINDOWS_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) {
    return true;
  }
  if (filePath.startsWith("/proc/")
    && (filePath.endsWith("/fd/0") || filePath.endsWith("/fd/1") || filePath.endsWith("/fd/2"))) {
    return true;
  }

  // Windows device paths: \\.\PhysicalDrive0, \\.\C:, etc.
  if (filePath.startsWith("\\\\.\\") || filePath.startsWith("\\\\?\\")) {
    const device = filePath.slice(4).split(/[\\/]/)[0]?.toUpperCase() ?? "";
    if (/^PHYSICALDRIVE\d+$/.test(device) || /^[A-Z]:$/.test(device) || WINDOWS_DEVICE_NAMES.has(device)) {
      return true;
    }
  }

  // Bare device names (e.g. "CON", "NUL") — strip any extension
  const basename = path.basename(filePath);
  const nameWithoutExt = basename.replace(/\.[^.]*$/, "").toUpperCase();
  if (WINDOWS_DEVICE_NAMES.has(nameWithoutExt)) {
    return true;
  }

  return false;
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
