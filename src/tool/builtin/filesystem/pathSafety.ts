import path from "node:path";
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import type { PilotDeckToolError } from "../../protocol/errors.js";
import { toolError } from "../../protocol/errors.js";

export type PilotDeckPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string; root: string }
  | { ok: false; error: PilotDeckToolError };

const DEFAULT_WRITE_DENY_DIRECTORIES = new Set([".git", "node_modules", "dist"]);
const MAX_SYMLINK_HOPS = 40;

export function resolvePilotDeckWorkspacePath(
  inputPath: string,
  context: PilotDeckToolRuntimeContext,
  options?: { forWrite?: boolean; mustExist?: boolean; allowOutsideWorkspace?: boolean; allowRegisteredReadFiles?: boolean },
): PilotDeckPathSafetyResult {
  if (!inputPath || inputPath.includes("\0")) {
    return {
      ok: false,
      error: toolError("invalid_tool_input", "Path must be a non-empty string without null bytes."),
    };
  }

  const absolutePath = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(context.cwd, inputPath));
  // Writes follow symlinks, so authorization must also hold for the path the
  // OS will actually write to, not just the literal path the caller supplied.
  const realWritePath = options?.forWrite ? resolveRealWritePath(absolutePath) : undefined;

  if (context.permissionMode === "bypassPermissions") {
    const relativePath = path.relative(context.cwd, absolutePath) || ".";
    if (options?.forWrite && (isWriteDenied(relativePath) || isRealWriteDenied(realWritePath, [context.cwd]))) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
      };
    }
    return { ok: true, absolutePath, relativePath, root: context.cwd };
  }

  const roots = [context.cwd, ...context.permissionContext.additionalWorkingDirectories].map((root) =>
    path.resolve(root),
  );
  const root = roots.find((candidate) => isPathWithinRoot(absolutePath, candidate));

  if (!root) {
    if (!options?.forWrite && options?.allowRegisteredReadFiles) {
      const real = safeRealpath(absolutePath);
      if (!real) {
        return {
          ok: false,
          error: toolError("file_not_found", `File ${inputPath} does not exist.`),
        };
      }
      const allowed = (context.allowedReadFiles ?? []).some((allowedPath) => {
        const allowedReal = safeRealpath(allowedPath) ?? path.resolve(allowedPath);
        return real === allowedReal;
      });
      if (allowed || isManagedImAttachmentFile(real, context)) {
        const relativePath = path.relative(context.cwd, absolutePath) || ".";
        return { ok: true, absolutePath, relativePath, root: context.cwd };
      }
    }

    if (options?.allowOutsideWorkspace) {
      const relativePath = path.relative(context.cwd, absolutePath) || ".";
      if (options?.forWrite && (isWriteDenied(relativePath) || isRealWriteDenied(realWritePath, roots))) {
        return {
          ok: false,
          error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
        };
      }
      return { ok: true, absolutePath, relativePath, root: context.cwd };
    }

    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} is outside the PilotDeck workspace.`),
    };
  }

  const relativePath = path.relative(root, absolutePath) || ".";
  if (options?.forWrite && (isWriteDenied(relativePath) || isRealWriteDenied(realWritePath, roots))) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
    };
  }

  if (realWritePath && !findRealRoot(realWritePath, roots) && !options?.allowOutsideWorkspace) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the PilotDeck workspace.`),
    };
  }

  if (options?.mustExist) {
    const real = safeRealpath(absolutePath);
    if (!real) {
      return {
        ok: false,
        error: toolError("file_not_found", `File ${inputPath} does not exist.`),
      };
    }

    const realRoot = safeRealpath(root) ?? root;
    if (!isPathWithinRoot(real, realRoot)) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the PilotDeck workspace.`),
      };
    }
  }

  return { ok: true, absolutePath, relativePath, root };
}

export function toWorkspaceRelativePath(absolutePath: string, root: string): string {
  return path.relative(root, absolutePath) || ".";
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves the path a write to `absolutePath` would land on after the OS
 * follows symlinks. Handles targets that do not exist yet (including dangling
 * symlinks) by resolving the deepest existing ancestor and re-appending the
 * remaining segments.
 */
export function resolveRealWritePath(absolutePath: string): string {
  const pending: string[] = [];
  let current = absolutePath;
  for (let linkHops = 0; linkHops <= MAX_SYMLINK_HOPS;) {
    const real = safeRealpath(current);
    if (real) {
      return path.join(real, ...pending);
    }
    const linkTarget = safeReadlink(current);
    if (linkTarget !== undefined) {
      current = path.resolve(path.dirname(current), linkTarget);
      linkHops += 1;
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    pending.unshift(path.basename(current));
    current = parent;
  }
  return path.join(current, ...pending);
}

function isWriteDenied(relativePath: string): boolean {
  const firstPart = relativePath.split(path.sep)[0];
  return firstPart !== undefined && DEFAULT_WRITE_DENY_DIRECTORIES.has(firstPart);
}

function isRealWriteDenied(realWritePath: string | undefined, roots: string[]): boolean {
  if (!realWritePath) {
    return false;
  }
  const realRoot = findRealRoot(realWritePath, roots);
  return realRoot !== undefined && isWriteDenied(path.relative(realRoot, realWritePath));
}

function findRealRoot(realPath: string, roots: string[]): string | undefined {
  return roots
    .map((root) => safeRealpath(root) ?? path.resolve(root))
    .find((realRoot) => isPathWithinRoot(realPath, realRoot));
}

function safeRealpath(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function safeReadlink(value: string): string | undefined {
  try {
    return readlinkSync(value);
  } catch {
    return undefined;
  }
}

function isManagedImAttachmentFile(realPath: string, context: PilotDeckToolRuntimeContext): boolean {
  const pilotHome = path.resolve(context.env?.PILOT_HOME ?? path.join(homedir(), ".pilotdeck"));
  const root = safeRealpath(path.join(pilotHome, "im-attachments")) ?? path.join(pilotHome, "im-attachments");
  return isPathWithinRoot(realPath, root) && isRegularFile(realPath);
}

function isRegularFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}
