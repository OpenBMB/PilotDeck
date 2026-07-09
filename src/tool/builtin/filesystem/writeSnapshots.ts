import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  PilotDeckToolRuntimeContext,
  PilotDeckWriteSnapshotEntry,
} from "../../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";
import { readTextFile } from "./readTextFile.js";

export function getWriteSnapshot(
  context: PilotDeckToolRuntimeContext,
  absolutePath: string,
): PilotDeckWriteSnapshotEntry | undefined {
  return context.writeSnapshots?.get(absolutePath);
}

export function recordWriteSnapshot(
  context: PilotDeckToolRuntimeContext,
  absolutePath: string,
  content: string,
  mtimeMs: number,
  range?: { offset?: number; limit?: number },
): void {
  context.writeSnapshots ??= new Map();
  context.writeSnapshots.set(absolutePath, {
    absolutePath,
    mtimeMs: Math.floor(mtimeMs),
    contentHash: hashText(content),
    offset: range?.offset,
    limit: range?.limit,
  });
}

export function invalidateReadFileState(
  context: { readFileState?: Map<string, unknown> },
  absolutePath: string,
): void {
  if (!context.readFileState) return;
  const prefix = `${absolutePath}::`;
  for (const key of context.readFileState.keys()) {
    if (key.startsWith(prefix)) {
      context.readFileState.delete(key);
    }
  }
}

export async function validateWriteSnapshotFresh(
  context: PilotDeckToolRuntimeContext,
  absolutePath: string,
): Promise<{ exists: boolean }> {
  const fileStat = await stat(absolutePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (!fileStat) {
    return { exists: false };
  }

  if (!fileStat.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${absolutePath} is not a regular file.`);
  }

  const snapshot = getWriteSnapshot(context, absolutePath);
  if (!snapshot) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "File has not been read yet. Read it first before writing to it.",
    );
  }

  const normalizedMtime = Math.floor(fileStat.mtimeMs);
  if (normalizedMtime === snapshot.mtimeMs) {
    return { exists: true };
  }

  const isFullRead = snapshot.offset === undefined && snapshot.limit === undefined;
  if (isFullRead) {
    const previousContent = await readTextFile(absolutePath);
    const currentHash = hashText(previousContent);
    if (currentHash === snapshot.contentHash) {
      return { exists: true };
    }
  }

  throw new PilotDeckToolRuntimeError(
    "invalid_tool_input",
    "File has changed since the last read. Read it again before writing to it.",
    {
      absolutePath,
      expectedMtimeMs: snapshot.mtimeMs,
      actualMtimeMs: normalizedMtime,
    },
  );
}

export async function ensureWriteSnapshotFresh(
  context: PilotDeckToolRuntimeContext,
  absolutePath: string,
): Promise<{ exists: boolean; previousContent: string | null; mtimeMs: number | null }> {
  const fileStat = await stat(absolutePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (!fileStat) {
    return { exists: false, previousContent: null, mtimeMs: null };
  }

  if (!fileStat.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${absolutePath} is not a regular file.`);
  }

  const snapshot = getWriteSnapshot(context, absolutePath);
  if (!snapshot) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "File has not been read yet. Read it first before writing to it.",
    );
  }

  const normalizedMtime = Math.floor(fileStat.mtimeMs);
  const previousContent = await readTextFile(absolutePath);
  const isFullRead = snapshot.offset === undefined && snapshot.limit === undefined;

  if (normalizedMtime !== snapshot.mtimeMs) {
    if (isFullRead) {
      const currentHash = hashText(previousContent);
      if (currentHash === snapshot.contentHash) {
        return { exists: true, previousContent, mtimeMs: normalizedMtime };
      }
    }
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "File has changed since the last read. Read it again before writing to it.",
      {
        absolutePath,
        expectedMtimeMs: snapshot.mtimeMs,
        actualMtimeMs: normalizedMtime,
      },
    );
  }

  if (!isFullRead) {
    return { exists: true, previousContent, mtimeMs: normalizedMtime };
  }

  const currentHash = hashText(previousContent);
  if (currentHash !== snapshot.contentHash) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "File has changed since the last read. Read it again before writing to it.",
      {
        absolutePath,
        expectedMtimeMs: snapshot.mtimeMs,
        actualMtimeMs: normalizedMtime,
      },
    );
  }

  return { exists: true, previousContent, mtimeMs: normalizedMtime };
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
