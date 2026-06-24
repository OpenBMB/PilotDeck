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

/**
 * Strip every `__fork_<shortTag>` suffix from an entryId, returning the
 * "root" id shared across all forks of the same origin conversation.
 *
 * Examples:
 *   "abc-123"                          → "abc-123"
 *   "abc-123__fork_def456"             → "abc-123"
 *   "abc-123__fork_def456__fork_xyz789" → "abc-123"
 *
 * A conversation file is invariant under this transform: either every entry
 * has no suffix, or every entry has exactly one (after chain-fork, every
 * entry in the resulting file has the new fork's suffix regardless of what
 * the source had).
 */
export function rootEntryIdOf(entryId: string): string {
  return entryId.replace(/(__fork_[a-f0-9]+)+$/i, "");
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

  // The truncation point is matched against the *root* entryId. This lets
  // chain-forks work: when the client passes an entryId from a previous fork
  // (e.g. "abc__fork_def"), we strip the suffix and look for the root
  // "abc" inside the source. The source may be a fork (every entry has its
  // own __fork_ suffix) or a non-fork (root === entryId); either way the
  // stripped root uniquely identifies the entry to keep up to.
  const upToRootId =
    input.upToEntryId !== undefined ? rootEntryIdOf(input.upToEntryId) : undefined;

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
      const rootId =
        typeof oldIdRaw === "string" && oldIdRaw.length > 0
          ? rootEntryIdOf(oldIdRaw)
          : null;

      // The new entryId is always `<root>__fork_<shortTag>` — never stack
      // suffixes. This keeps chain-fork idempotent and the on-disk format
      // shallow (one fork-suffix per file, no matter how many ancestors).
      const newId =
        rootId !== null ? `${rootId}__fork_${shortTag}` : oldIdRaw;

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
          } else {
            // Remap by root. The source parent might be a previous fork's
            // entryId (`abc__fork_def`); we strip to root and look up in
            // `remap`, which is keyed by root. The cloned parent then points
            // at the freshly-suffixed entry in this fork.
            const parentRoot = rootEntryIdOf(srcParent);
            if (remap.has(parentRoot)) {
              clone.parentEntryId = remap.get(parentRoot);
            } else {
              // The parent entry is either missing or appears after the fork
              // point in the source. Either way the resulting transcript
              // would reference an entry we did not keep.
              throw new ForkError(
                `parentEntryId references an entry beyond the fork point: ${srcParent}`,
              );
            }
          }
        }
        // srcParent === null / undefined → keep as-is (already mirrored via deep clone).
      }

      await appendFile(newJsonlPath, JSON.stringify(clone) + "\n", "utf8");
      if (rootId !== null) {
        remap.set(rootId, newId as string);
      }
      entryCount += 1;

      // If upToEntryId is set, stop AFTER copying the rest of the turn
      // that contains it (so the user always gets a complete turn triple:
      // accepted_input + assistant_message + turn_result). If upToEntryId
      // is not set, copy every entry (whole conversation).
      if (
        upToRootId !== undefined &&
        rootId !== null &&
        rootId === upToRootId
      ) {
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
