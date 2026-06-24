import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import readline from "node:readline";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "./ProjectSessionStorage.js";

/**
 * Error raised by {@link forkSession} for any structural problem encountered
 * while forking a transcript (missing source, malformed lines, missing fork
 * point, parent references past the fork boundary, etc.). Callers can use
 * `instanceof ForkError` to distinguish from filesystem / I/O errors.
 */
export class ForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkError";
  }
}

export type ForkSessionInput = {
  pilotHome: string;
  projectRoot: string;
  sourceSessionId: string;
  upToEntryId?: string;
  newSessionId?: string;
  forkedAt?: string;
  /** Optional override for the displayed title; computed if omitted. */
  sourceSummary?: string;
};

export type ForkSessionResult = {
  newSessionId: string;
  newSafeId: string;
  newJsonlPath: string;
  metaPath: string;
  entryCount: number;
  forkedFromEntryId: string;
  forkedAt: string;
  customTitle: string;
};

/**
 * Create a new session transcript by copying entries from a source transcript
 * up to (and including) a specified `upToEntryId`.
 *
 * - Each kept entry is rewritten: `entryId` gets a `__fork_<shortTag>` suffix
 *   and `sessionId` is replaced with the new session id.
 * - `parentEntryId` references are remapped to the new entry ids when
 *   possible; if a kept entry references a parent that is *beyond* the fork
 *   point, a {@link ForkError} is thrown (the result would be a structurally
 *   broken transcript).
 * - All other fields are preserved verbatim.
 * - A sidecar `<safeId>.meta.json` is written atomically next to the new
 *   JSONL file, recording the fork origin and a derived `customTitle`.
 */
export async function forkSession(input: ForkSessionInput): Promise<ForkSessionResult> {
  const chatDir = getPilotProjectChatDir(input.projectRoot, input.pilotHome);
  const sourceSafeId = sanitizeSessionIdForPath(input.sourceSessionId);
  const sourcePath = resolve(chatDir, `${sourceSafeId}.jsonl`);

  // Verify the source file exists up-front. Surface a clean ForkError so
  // callers can react without sniffing ENOENT.
  try {
    await stat(sourcePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new ForkError(`source session not found: ${input.sourceSessionId}`);
    }
    throw err;
  }

  const newSessionId = input.newSessionId ?? randomUUID();
  const shortTag = newSessionId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const newSafeId = sanitizeSessionIdForPath(newSessionId);
  const newJsonlPath = resolve(chatDir, `${newSafeId}.jsonl`);
  const metaPath = resolve(chatDir, `${newSafeId}.meta.json`);

  // Make sure the chat dir exists. The caller may have just initialised
  // a fresh project root; recursive mkdir is idempotent.
  await mkdir(chatDir, { recursive: true });

  const remap = new Map<string, string>();
  let foundUpTo = false;
  let entryCount = 0;
  let lineNo = 0;

  const stream = createReadStream(sourcePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    let inMatchingTurn = false;
    for await (const rawLine of rl) {
      lineNo += 1;
      if (rawLine.length === 0) continue;

      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawLine);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        entry = parsed as Record<string, unknown>;
      } catch {
        throw new ForkError(`malformed line in source transcript at line ${lineNo}`);
      }

      const oldIdRaw = entry.entryId;
      if (typeof oldIdRaw === "string" && oldIdRaw.includes("__fork_")) {
        throw new ForkError(
          `cannot fork transcript: entry at line ${lineNo} already contains "__fork_" in entryId (${oldIdRaw})`,
        );
      }
      const newId = typeof oldIdRaw === "string" ? `${oldIdRaw}__fork_${shortTag}` : oldIdRaw;

      // Deep-clone via JSON so any nested fields (metadata, messages, payload,
      // result, etc.) survive verbatim. Transcript entries are pure JSON.
      const clone = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
      clone.entryId = newId;
      clone.sessionId = newSessionId;

      if ("parentEntryId" in entry) {
        const srcParent = entry.parentEntryId;
        if (srcParent != null) {
          if (typeof srcParent !== "string") {
            // Unknown shape — preserve verbatim rather than guessing.
          } else if (remap.has(srcParent)) {
            clone.parentEntryId = remap.get(srcParent);
          } else {
            // The parent entry is either missing or appears after the fork
            // point in the source. Either way the resulting transcript would
            // reference an entry we did not keep.
            throw new ForkError(
              `parentEntryId references an entry beyond the fork point: ${srcParent}`,
            );
          }
        }
        // srcParent === null / undefined → keep as-is (already mirrored via deep clone).
      }

      await appendFile(newJsonlPath, JSON.stringify(clone) + "\n", "utf8");
      if (typeof oldIdRaw === "string" && oldIdRaw.length > 0) {
        remap.set(oldIdRaw, newId as string);
      }
      entryCount += 1;

      // If upToEntryId is set, stop AFTER copying the rest of the turn
      // that contains it (so the user always gets a complete turn triple:
      // accepted_input + assistant_message + turn_result). If upToEntryId
      // is not set, copy every entry (whole conversation).
      if (input.upToEntryId !== undefined && oldIdRaw === input.upToEntryId) {
        foundUpTo = true;
        if (entry.type === "turn_result") {
          break;
        }
        inMatchingTurn = true;
        continue;
      }
      if (inMatchingTurn && entry.type === "turn_result") {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (input.upToEntryId !== undefined && !foundUpTo) {
    throw new ForkError(
      `upToEntryId not found in source transcript: ${input.upToEntryId}`,
    );
  }

  const forkedAt = input.forkedAt ?? new Date().toISOString();

  let customTitle: string;
  if (input.sourceSummary && input.sourceSummary.length > 0) {
    customTitle = `Fork of ${input.sourceSummary.slice(0, 60)}`;
  } else {
    customTitle = `Fork of ${sourceSafeId.slice(0, 16)}`;
  }

  const metaBody = JSON.stringify(
    {
      forkedFrom: {
        sessionId: input.sourceSessionId,
        entryId: input.upToEntryId ?? null,
        forkedAt,
      },
      customTitle,
    },
    null,
    2,
  );
  const tmpMetaPath = `${metaPath}.tmp`;
  await writeFile(tmpMetaPath, metaBody, "utf8");
  await rename(tmpMetaPath, metaPath);

  return {
    newSessionId,
    newSafeId,
    newJsonlPath,
    metaPath,
    entryCount,
    forkedFromEntryId: input.upToEntryId ?? null,
    forkedAt,
    customTitle,
  };
}
