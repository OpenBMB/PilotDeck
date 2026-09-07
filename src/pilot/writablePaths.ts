import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveProjectStorageId } from "./paths.js";

const WINDOWS_RUNTIME_RE = /[\\/]resources[\\/]runtime$/i;
const FALLBACK_ERROR_CODES = new Set(["EPERM", "EACCES", "EROFS"]);

export type EnsureWritableDirectoryInput = {
  preferredDir: string;
  fallbackDir: string;
  purpose: string;
};

export type EnsureWritableDirectoryResult = {
  dir: string;
  usedFallback: boolean;
};

export function ensureWritableDirectory(input: EnsureWritableDirectoryInput): EnsureWritableDirectoryResult {
  const preferredDir = resolve(input.preferredDir);
  try {
    createAndProbeWritableDirectory(preferredDir, input.purpose);
    return { dir: preferredDir, usedFallback: false };
  } catch (error) {
    if (!isFallbackDirectoryError(error)) {
      throw error;
    }
  }

  const fallbackDir = resolve(input.fallbackDir);
  createAndProbeWritableDirectory(fallbackDir, input.purpose);
  return { dir: fallbackDir, usedFallback: true };
}

export function isDesktopRuntimeProjectRoot(input: {
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): boolean {
  const env = input.env ?? process.env;
  if (env.PILOTDECK_DESKTOP !== "1") {
    return false;
  }
  const normalized = normalize(resolve(input.projectRoot));
  if (env.PILOTDECK_DESKTOP_RUNTIME_ROOT && normalized === normalize(resolve(env.PILOTDECK_DESKTOP_RUNTIME_ROOT))) {
    return true;
  }
  return WINDOWS_RUNTIME_RE.test(normalized);
}

export function isVirtualProjectRoot(input: {
  projectRoot?: string | null;
  pilotHome: string;
  env?: Record<string, string | undefined>;
}): boolean {
  if (!input.projectRoot) {
    return false;
  }
  const projectRoot = resolve(input.projectRoot);
  if (projectRoot === resolve(input.pilotHome)) {
    return true;
  }
  return isDesktopRuntimeProjectRoot({ projectRoot, env: input.env });
}

export function resolvePilotHomeProjectArtifactDir(input: {
  pilotHome: string;
  projectRoot: string;
  artifact: string;
}): string {
  const projectId = resolveProjectStorageId(input.projectRoot, input.pilotHome);
  return resolve(input.pilotHome, "projects", projectId, input.artifact);
}

export function resolveRuntimeArtifactFallbackDir(input: {
  pilotHome: string;
  purpose: string;
  key?: string;
}): string {
  return resolve(
    input.pilotHome,
    "runtime",
    sanitizePathComponent(input.purpose),
    ...(input.key ? [sanitizePathComponent(input.key)] : []),
  );
}

function createAndProbeWritableDirectory(dir: string, purpose: string): void {
  mkdirSync(dir, { recursive: true });
  const probePath = join(dir, `.pilotdeck-write-test-${sanitizePathComponent(purpose)}-${randomUUID()}.tmp`);
  const fd = openSync(probePath, "wx");
  closeSync(fd);
  rmSync(probePath, { force: true });
}

function isFallbackDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && FALLBACK_ERROR_CODES.has(code);
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[\\/:<>"|?*\s]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
