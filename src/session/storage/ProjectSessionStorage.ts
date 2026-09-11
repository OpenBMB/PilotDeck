import { resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { JsonlTranscriptWriter } from "../transcript/JsonlTranscriptWriter.js";
import type {
  AgentTranscriptEntry,
  AgentSubagentCompletedTranscriptEntry,
  AgentSubagentStartedTranscriptEntry,
} from "../transcript/TranscriptEntry.js";
import {
  readTranscript as readTranscriptFile,
  type AgentTranscriptReadResult,
  type ReadTranscriptOptions,
} from "../transcript/TranscriptReader.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "../transcript/TranscriptWriter.js";
import type { FileHistoryBackupStorage } from "../filesystem/types.js";
import type { ToolResultArtifactStorage } from "../artifacts/ToolResultArtifactStorage.js";

export type AgentProjectSessionStorageOptions = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  now?: () => Date;
};

type AsyncTranscriptMethod<T> = T extends (...args: infer Args) => unknown
  ? (...args: Args) => Promise<void>
  : never;

/**
 * Native session transcript contract. JSONL is the default implementation,
 * while Gateway hosts may provide an equivalent durable writer backed by an
 * asynchronous database or object store.
 */
export type AgentProjectTranscriptWriter = Omit<AgentTranscriptWriter,
  | "recordAcceptedInput"
  | "recordDurableMessage"
  | "recordAgentStatusMessage"
  | "recordFileArtifacts"
  | "recordTurnResult"
  | "recordSessionMetadata"
  | "recordFileSnapshot"
  | "recordControlBoundary"
> & {
  recordAcceptedInput: AsyncTranscriptMethod<AgentTranscriptWriter["recordAcceptedInput"]>;
  recordDurableMessage: AsyncTranscriptMethod<AgentTranscriptWriter["recordDurableMessage"]>;
  recordAgentStatusMessage: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordAgentStatusMessage"]>>;
  recordFileArtifacts: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordFileArtifacts"]>>;
  recordTurnResult: AsyncTranscriptMethod<AgentTranscriptWriter["recordTurnResult"]>;
  recordSessionMetadata: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordSessionMetadata"]>>;
  recordFileSnapshot: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordFileSnapshot"]>>;
  recordControlBoundary: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordControlBoundary"]>>;
  restoreState(maxSequence: number, lastEntryId: string | null): void;
  forSubagent(subagentId: string, now?: () => Date): AgentProjectSubagentTranscriptHandle;
  relativeSubagentPath(subagentId: string): string;
  recordSubagentStarted(
    sessionId: string,
    turnId: string,
    args: Omit<AgentSubagentStartedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId" | "promptPreview" | "promptTruncated"> & { prompt: string },
  ): Promise<void>;
  recordSubagentCompleted(
    sessionId: string,
    turnId: string,
    args: Omit<AgentSubagentCompletedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId" | "summaryPreview" | "summaryTruncated"> & { summary: string },
  ): Promise<void>;
  snapshotState(): AgentTranscriptWriterState;
};

export type AgentProjectSubagentTranscriptHandle = {
  subagentId: string;
  writer: AgentProjectTranscriptWriter;
  transcriptPath: string;
};

export type AgentProjectTranscriptReader = (
  options?: ReadTranscriptOptions,
) => Promise<AgentTranscriptReadResult>;

export type AgentProjectTranscriptPathReader = (
  transcriptPath: string,
  options?: ReadTranscriptOptions,
) => Promise<AgentTranscriptReadResult>;

export type AgentProjectTranscriptReplacement = Readonly<{
  transactionId: string;
  replacementTurnId: string;
  entries: readonly AgentTranscriptEntry[];
  owner?: Readonly<{ instanceId: string; pid: number }>;
}>;

/**
 * Copies the sidechain transcript payloads referenced by a parent transcript
 * during a session fork. The caller supplies the exact source primary entries
 * and an auxiliary-path transform so storage backends do not need to own the
 * Web fork policy.
 */
export type AgentProjectTranscriptSidechainFork = Readonly<{
  sourceStorage: AgentProjectSessionStorage;
  sourceTranscriptEntries: readonly AgentTranscriptEntry[];
  transformEntry: (entry: AgentTranscriptEntry) => AgentTranscriptEntry;
}>;

/** Copies the file-history backup blobs referenced by a parent transcript fork. */
export type AgentProjectFileHistoryFork = Readonly<{
  sourceStorage: AgentProjectSessionStorage;
  sourceTranscriptEntries: readonly AgentTranscriptEntry[];
}>;

/** Copies the oversized tool-result payloads referenced by a transcript fork. */
export type AgentProjectToolResultArtifactFork = Readonly<{
  sourceStorage: AgentProjectSessionStorage;
  sourceTranscriptEntries: readonly AgentTranscriptEntry[];
}>;

export type AgentProjectSessionStorage = {
  chatDir: string;
  transcriptPath: string;
  toolResultsDir: string;
  /** Optional host-owned payload store for oversized tool results and media. */
  toolResultArtifactStorage?: ToolResultArtifactStorage;
  /** Optional host-owned cleanup of every oversized tool-result payload for this session. */
  deleteToolResultArtifacts?: () => Promise<void>;
  /**
   * Per-session directory for file-history backups (C4 / F5). Backups land
   * at `<fileHistoryDir>/<sha16(filePath)>@v<version>` and survive process
   * restarts. The `FileHistoryStore` lazily creates the dir on first
   * `trackEdit`.
   */
  fileHistoryDir: string;
  /** Optional host-owned backup blobs used by the native FileHistoryStore. */
  fileHistoryBackupStorage?: FileHistoryBackupStorage;
  /** Optional host-owned cleanup of every backup blob for this session. */
  deleteFileHistoryBackups?: () => Promise<void>;
  /**
   * Per-session directory for subagent sidechain transcripts (C3 §6.3).
   * Each forked subagent gets its own `<subagentId>.jsonl` here.
   */
  subagentsDir: string;
  subagentTranscriptPath(subagentId: string): string;
  transcript: AgentProjectTranscriptWriter;
  /**
   * Optional host-owned transcript reader. When absent, the historical JSONL
   * path is read exactly as before. The Gateway uses this reader for resume
   * and message projection, keeping transcript ownership at the host.
   */
  readTranscript?: AgentProjectTranscriptReader;
  /** Optional host-owned reader for subagent sidechain transcript paths. */
  readTranscriptAtPath?: AgentProjectTranscriptPathReader;
  /** Optional host-owned existence check for a non-filesystem transcript. */
  transcriptExists?: () => Promise<boolean>;
  /** Optional host-owned deletion for a non-filesystem transcript. */
  deleteTranscript?: () => Promise<void>;
  /** Optional host-owned deletion of a primary transcript and every sidechain payload. */
  deleteSessionTranscripts?: () => Promise<void>;
  /** Optional atomic transcript replacement for host-owned storage. */
  replaceTranscript?: (entries: readonly AgentTranscriptEntry[]) => Promise<void>;
  /** Optional durable prepare step for Gateway-owned last-turn replacement. */
  prepareTranscriptReplacement?: (replacement: AgentProjectTranscriptReplacement) => Promise<void>;
  /** Optional durable commit/rollback step for a prepared replacement. */
  finalizeTranscriptReplacement?: (input: { transactionId: string; action: "commit" | "rollback" }) => Promise<void>;
  /** Optional host-owned recovery for abandoned external replacement transactions. */
  recoverTranscriptReplacements?: () => Promise<void>;
  /** Optional copy of the sidechain transcript payloads referenced by a fork. */
  copyTranscriptSidechains?: (input: AgentProjectTranscriptSidechainFork) => Promise<void>;
  /** Optional copy of file-history backup blobs referenced by a fork. */
  copyFileHistoryBackups?: (input: AgentProjectFileHistoryFork) => Promise<void>;
  /** Optional copy of oversized tool-result payloads referenced by a fork. */
  copyToolResultArtifacts?: (input: AgentProjectToolResultArtifactFork) => Promise<void>;
  /** Signals that transcript bytes are owned by a non-filesystem backend. */
  externalTranscriptStore?: boolean;
};

/**
 * Sanitize a sessionId for safe use as a single filename component.
 *
 * sessionKeys for non-Web channels (TUI/CLI) embed the absolute project path,
 * e.g. `tui:project=/Users/foo/work/repo:default`. Without sanitization the
 * raw `/` characters make `path.resolve()` treat the sessionId as multiple
 * path segments, burying the transcript under
 * `chats/tui:project=/Users/foo/work/repo:default.jsonl` (a deep dir tree)
 * instead of a flat file. `listProjectSessions` then can't find these
 * sessions in its flat `chats/` scan.
 *
 * We replace **only** path-separator characters (`/` and `\`) so existing
 * keys like `web:s_<uuid>` (which legitimately use `:`) keep their
 * on-disk filenames unchanged and stay backward compatible.
 */
export function sanitizeSessionIdForPath(sessionId: string): string {
  // On Windows, `:` is reserved (drive letters / ADS) and cannot appear in
  // filenames.  Strip it alongside path separators so that TUI-style session
  // keys like `tui:project=/Users/foo:default` produce a single flat file.
  const illegal = process.platform === "win32" ? /[\\/:<>"|?*]+/g : /[\\/]+/g;
  return sessionId.replace(illegal, "-").replace(/^-+|-+$/g, "") || "session";
}

/** Reads a native session transcript through its configured host backend. */
export async function readAgentProjectSessionTranscript(
  storage: AgentProjectSessionStorage,
  options: ReadTranscriptOptions = {},
): Promise<AgentTranscriptReadResult> {
  await storage.recoverTranscriptReplacements?.();
  return storage.readTranscript?.(options) ?? readTranscriptFile(storage.transcriptPath, options);
}

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const safeId = sanitizeSessionIdForPath(options.sessionId);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  // Keep large tool-result bodies inside the workspace so the agent can read
  // them back with read_file when the inline preview is insufficient. The
  // project-local .pilotdeck directory is gitignored and already within the
  // workspace path boundary enforced by read_file.
  const toolResultsDir = resolve(options.projectRoot, ".pilotdeck", "tool-results", safeId);
  const fileHistoryDir = resolve(chatDir, safeId, "file-history");
  const subagentsDir = resolve(chatDir, safeId, "subagents");
  const subagentTranscriptPath = (subagentId: string): string =>
    resolve(subagentsDir, `${sanitizeSessionIdForPath(subagentId)}.jsonl`);
  return {
    chatDir,
    transcriptPath,
    toolResultsDir,
    fileHistoryDir,
    subagentsDir,
    subagentTranscriptPath,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
      subagentTranscriptPath,
    }),
  };
}
