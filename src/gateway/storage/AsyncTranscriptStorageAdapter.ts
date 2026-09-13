import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { AgentTranscriptReadResult, ReadTranscriptOptions } from "../../session/transcript/TranscriptReader.js";
import { JsonlTranscriptWriter } from "../../session/transcript/JsonlTranscriptWriter.js";
import { replayTranscriptEntries } from "../../session/transcript/TranscriptReplay.js";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { SessionInfo } from "../../session/storage/SessionList.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../../session/storage/ProjectSessionStorage.js";
import type {
  GatewayNativeProjectStorageInput,
  GatewayNativeSessionStorageAdapter,
  GatewayNativeSessionStorageInput,
} from "./NativeSessionStorageAdapter.js";

/**
 * Stable host key for one native transcript stream. `transcriptPath` remains
 * an absolute Gateway-local identifier for file-history and diagnostics, but
 * the host store owns the durable transcript contents.
 */
export type GatewayAsyncTranscriptKey = Readonly<{
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  transcriptPath: string;
}>;

export type GatewayAsyncTranscriptProjectKey = Readonly<{
  projectRoot: string;
  pilotHome: string;
}>;

/** Minimal index entry needed for host-owned session listing. */
export type GatewayAsyncTranscriptSession = Readonly<{
  sessionId: string;
  lastModified: number;
  fileSize?: number;
}>;

/**
 * Host-supplied transcript persistence. Implementations can
 * map the key to a database table, an object-store append log, or another
 * durable service. `append` must be atomic for a key; the writer serializes
 * calls in process but cannot coordinate multiple Gateway processes.
 */
export type GatewayAsyncTranscriptStore = {
  append(key: GatewayAsyncTranscriptKey, entry: AgentTranscriptEntry): void | Promise<void>;
  read(key: GatewayAsyncTranscriptKey, options?: ReadTranscriptOptions): Promise<AgentTranscriptReadResult>;
  /** Optional project index for `listSessions`; absent stores retain JSONL listing behavior. */
  list?(key: GatewayAsyncTranscriptProjectKey): Promise<readonly GatewayAsyncTranscriptSession[]>;
  /** Optional existence check used by Gateway delete and restore conflict checks. */
  has?(key: GatewayAsyncTranscriptKey): Promise<boolean>;
  /** Optional primary transcript deletion used by Gateway `deleteSession`. */
  delete?(key: GatewayAsyncTranscriptKey): Promise<void>;
  /** Optional deletion of a primary transcript plus every sidechain payload for its session. */
  deleteSession?(key: GatewayAsyncTranscriptKey): Promise<void>;
  /** Optional atomic primary transcript replacement used by portable restore. */
  replace?(key: GatewayAsyncTranscriptKey, entries: readonly AgentTranscriptEntry[]): Promise<void>;
  /** Optional durable prepare for Gateway last-turn replacement. */
  prepareReplacement?(key: GatewayAsyncTranscriptKey, input: {
    transactionId: string;
    replacementTurnId: string;
    entries: readonly AgentTranscriptEntry[];
  }): Promise<void>;
  /** Optional durable commit/rollback for a prepared Gateway replacement. */
  finalizeReplacement?(key: GatewayAsyncTranscriptKey, input: {
    transactionId: string;
    action: "commit" | "rollback";
  }): Promise<void>;
  /**
   * Optional idempotent recovery for transactions left by a dead Gateway.
   * The host owns leases/owner checks and must leave a live transaction alone.
   * This hook runs before Gateway transcript reads for the session.
   */
  recoverReplacements?(key: GatewayAsyncTranscriptKey): Promise<void>;
  /** Optional per-session checkpoint blob storage for native file history. */
  fileHistoryBackups?: {
    write(key: GatewayAsyncTranscriptKey, backupFileName: string, bytes: Uint8Array): void | Promise<void>;
    read(key: GatewayAsyncTranscriptKey, backupFileName: string): Promise<Uint8Array | undefined>;
    delete(key: GatewayAsyncTranscriptKey, backupFileName: string): void | Promise<void>;
    deleteAll(key: GatewayAsyncTranscriptKey): void | Promise<void>;
  };
  /** Optional per-session immutable payload storage for oversized tool results and media. */
  toolResultArtifacts?: {
    write(key: GatewayAsyncTranscriptKey, artifactName: string, bytes: Uint8Array): void | Promise<void>;
    read(key: GatewayAsyncTranscriptKey, artifactName: string): Promise<Uint8Array | undefined>;
    delete(key: GatewayAsyncTranscriptKey, artifactName: string): void | Promise<void>;
    deleteAll(key: GatewayAsyncTranscriptKey): void | Promise<void>;
  };
};

export type CreateGatewayAsyncTranscriptStorageAdapterOptions = {
  store: GatewayAsyncTranscriptStore;
  /**
   * Optional Gateway-local layout for non-transcript native artifacts such
   * as file-history backups and tool-result files. The transcript payload is
   * never written there by this adapter; file-history backup blobs can
   * independently be delegated through `fileHistoryBackups`.
   */
  createSessionStorage?: (input: GatewayNativeSessionStorageInput) => AgentProjectSessionStorage;
  getProjectChatDir?: (input: GatewayNativeProjectStorageInput) => string;
};

/**
 * Builds a `nativeSessionStorage` adapter whose primary and subagent
 * transcript records are persisted through a host-owned async store.
 *
 * It deliberately changes the transcript boundary only. Optional store index
 * operations can also serve session list/delete and atomic transcript
 * creation. When the store also supports `replace`, referenced sidechain
 * transcript payloads are copied for a fork. File-history checkpoint blobs
 * can use the optional host store. When `toolResultArtifacts` is supplied,
 * oversized text/media payloads are durable in that store while the Gateway
 * recreates its workspace-local `read_file`/media cache on resume.
 */
export function createGatewayAsyncTranscriptStorageAdapter(
  options: CreateGatewayAsyncTranscriptStorageAdapterOptions,
): GatewayNativeSessionStorageAdapter {
  const createStorage = (input: GatewayNativeSessionStorageInput): AgentProjectSessionStorage => {
    const base = options.createSessionStorage?.(input) ?? createAgentProjectSessionStorage(input);
    const keyForPath = (transcriptPath: string): GatewayAsyncTranscriptKey => Object.freeze({
      projectRoot: input.projectRoot,
      pilotHome: input.pilotHome,
      sessionId: input.sessionId,
      transcriptPath,
    });
    const appendEntry = async (transcriptPath: string, entry: AgentTranscriptEntry): Promise<void> => {
      await options.store.append(keyForPath(transcriptPath), structuredClone(entry));
    };
    const transcript = new JsonlTranscriptWriter({
      path: base.transcriptPath,
      now: input.now,
      subagentTranscriptPath: base.subagentTranscriptPath,
      appendEntry,
    });
    return {
      ...base,
      transcript,
      externalTranscriptStore: true,
      readTranscript: async (readOptions) => cloneReadResult(
        await options.store.read(keyForPath(base.transcriptPath), readOptions),
      ),
      readTranscriptAtPath: async (transcriptPath, readOptions) => cloneReadResult(
        await options.store.read(keyForPath(transcriptPath), readOptions),
      ),
      ...(options.store.has
        ? { transcriptExists: () => options.store.has!(keyForPath(base.transcriptPath)) }
        : {}),
      ...(options.store.delete
        ? { deleteTranscript: () => options.store.delete!(keyForPath(base.transcriptPath)) }
        : {}),
      ...(options.store.deleteSession
        ? { deleteSessionTranscripts: () => options.store.deleteSession!(keyForPath(base.transcriptPath)) }
        : {}),
      ...(options.store.replace
        ? {
            replaceTranscript: (entries: readonly AgentTranscriptEntry[]) => options.store.replace!(
              keyForPath(base.transcriptPath),
              entries.map((entry) => structuredClone(entry)),
            ),
          }
        : {}),
      ...(options.store.prepareReplacement && options.store.finalizeReplacement
        ? {
            prepareTranscriptReplacement: (replacement) => options.store.prepareReplacement!(
              keyForPath(base.transcriptPath),
              {
                transactionId: replacement.transactionId,
                replacementTurnId: replacement.replacementTurnId,
                entries: replacement.entries.map((entry) => structuredClone(entry)),
                ...(replacement.owner ? { owner: { ...replacement.owner } } : {}),
              },
            ),
            finalizeTranscriptReplacement: (input) => options.store.finalizeReplacement!(
              keyForPath(base.transcriptPath),
              input,
            ),
          }
        : {}),
      ...(options.store.recoverReplacements
        ? {
            recoverTranscriptReplacements: () => options.store.recoverReplacements!(
              keyForPath(base.transcriptPath),
            ),
          }
        : {}),
      ...(options.store.replace
        ? {
            copyTranscriptSidechains: async (fork) => {
              const sourceReader = fork.sourceStorage.readTranscriptAtPath;
              if (!sourceReader) {
                throw new Error(
                  "The configured source transcript storage cannot read sidechain payloads for fork creation.",
                );
              }
              const copied = new Set<string>();
              const copyFromParent = async (
                sourceParentPath: string,
                targetParentPath: string,
                sourceEntries: readonly AgentTranscriptEntry[],
              ): Promise<void> => {
                for (const entry of sourceEntries) {
                  if (entry.type !== "subagent_started") continue;
                  const sourceSidechainPath = resolve(dirname(sourceParentPath), entry.transcriptRelativePath);
                  if (copied.has(sourceSidechainPath)) continue;
                  copied.add(sourceSidechainPath);

                  const transformedStart = fork.transformEntry(structuredClone(entry));
                  if (transformedStart.type !== "subagent_started") {
                    throw new Error("Fork sidechain transform changed a subagent_started transcript entry type.");
                  }
                  const targetSidechainPath = resolve(
                    dirname(targetParentPath),
                    transformedStart.transcriptRelativePath,
                  );
                  const sourceResult = await sourceReader(sourceSidechainPath);
                  const errors = sourceResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
                  if (errors.length > 0) {
                    throw new Error(
                      `Cannot copy fork sidechain transcript ${sourceSidechainPath}: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`,
                    );
                  }
                  const copiedEntries = sourceResult.entries.map((sourceEntry) =>
                    fork.transformEntry(structuredClone(sourceEntry)),
                  );
                  await options.store.replace!(
                    keyForPath(targetSidechainPath),
                    copiedEntries.map((copiedEntry) => structuredClone(copiedEntry)),
                  );
                  await copyFromParent(sourceSidechainPath, targetSidechainPath, sourceResult.entries);
                }
              };
              await copyFromParent(
                fork.sourceStorage.transcriptPath,
                base.transcriptPath,
                fork.sourceTranscriptEntries,
              );
            },
          }
        : {}),
      ...(options.store.fileHistoryBackups
        ? {
            fileHistoryBackupStorage: {
              write: (backupFileName: string, bytes: Uint8Array) => options.store.fileHistoryBackups!.write(
                keyForPath(base.transcriptPath),
                backupFileName,
                bytes.slice(),
              ),
              read: async (backupFileName: string) => {
                const bytes = await options.store.fileHistoryBackups!.read(
                  keyForPath(base.transcriptPath),
                  backupFileName,
                );
                return bytes?.slice();
              },
              delete: (backupFileName: string) => options.store.fileHistoryBackups!.delete(
                keyForPath(base.transcriptPath),
                backupFileName,
              ),
            },
            deleteFileHistoryBackups: async () => {
              await options.store.fileHistoryBackups!.deleteAll(keyForPath(base.transcriptPath));
            },
            copyFileHistoryBackups: async (fork) => {
              const sourceBackups = fork.sourceStorage.fileHistoryBackupStorage;
              if (!sourceBackups) {
                throw new Error(
                  "The configured source transcript storage cannot read file-history backup payloads for fork creation.",
                );
              }
              const names = new Set<string>();
              for (const entry of fork.sourceTranscriptEntries) {
                if (entry.type !== "file_snapshot_recorded") continue;
                for (const backup of Object.values(entry.trackedFileBackups)) {
                  if (backup.backupFileName) names.add(backup.backupFileName);
                }
              }
              for (const backupFileName of names) {
                const bytes = await sourceBackups.read(backupFileName);
                // Match the filesystem fork behavior: a transcript can refer
                // to a manually-pruned backup, which remains a recoverable
                // "missing" checkpoint rather than making the whole fork fail.
                if (!bytes) continue;
                await options.store.fileHistoryBackups!.write(
                  keyForPath(base.transcriptPath),
                  backupFileName,
                  bytes.slice(),
                );
              }
            },
          }
        : {}),
      ...(options.store.toolResultArtifacts
        ? {
            toolResultArtifactStorage: {
              write: (artifactName: string, bytes: Uint8Array) => options.store.toolResultArtifacts!.write(
                keyForPath(base.transcriptPath),
                artifactName,
                bytes.slice(),
              ),
              read: async (artifactName: string) => {
                const bytes = await options.store.toolResultArtifacts!.read(
                  keyForPath(base.transcriptPath),
                  artifactName,
                );
                return bytes?.slice();
              },
              delete: (artifactName: string) => options.store.toolResultArtifacts!.delete(
                keyForPath(base.transcriptPath),
                artifactName,
              ),
              deleteAll: () => options.store.toolResultArtifacts!.deleteAll(
                keyForPath(base.transcriptPath),
              ),
            },
            deleteToolResultArtifacts: async () => {
              await options.store.toolResultArtifacts!.deleteAll(keyForPath(base.transcriptPath));
            },
            copyToolResultArtifacts: async (fork) => {
              const sourceArtifacts = fork.sourceStorage.toolResultArtifactStorage;
              if (!sourceArtifacts) return;
              const names = new Set<string>();
              const seenSidechains = new Set<string>();
              const collect = async (
                sourceParentPath: string,
                entries: readonly AgentTranscriptEntry[],
              ): Promise<void> => {
                for (const entry of entries) {
                  collectToolResultArtifactNames(entry, fork.sourceStorage.toolResultsDir, names);
                  if (entry.type !== "subagent_started") continue;
                  const sourceSidechainPath = resolve(dirname(sourceParentPath), entry.transcriptRelativePath);
                  if (seenSidechains.has(sourceSidechainPath)) continue;
                  seenSidechains.add(sourceSidechainPath);
                  const sourceReader = fork.sourceStorage.readTranscriptAtPath;
                  if (!sourceReader) continue;
                  const sourceResult = await sourceReader(sourceSidechainPath);
                  const errors = sourceResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
                  if (errors.length > 0) {
                    throw new Error(
                      `Cannot inspect fork sidechain transcript ${sourceSidechainPath}: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`,
                    );
                  }
                  await collect(sourceSidechainPath, sourceResult.entries);
                }
              };
              await collect(fork.sourceStorage.transcriptPath, fork.sourceTranscriptEntries);
              for (const artifactName of names) {
                const bytes = await sourceArtifacts.read(artifactName);
                // A transcript may reference a manually pruned payload. Match
                // filesystem fork behavior by retaining that missing state.
                if (!bytes) continue;
                await options.store.toolResultArtifacts!.write(
                  keyForPath(base.transcriptPath),
                  artifactName,
                  bytes.slice(),
                );
              }
            },
          }
        : {}),
    };
  };
  return {
    getProjectChatDir(input) {
      if (options.getProjectChatDir) return options.getProjectChatDir(input);
      return createAgentProjectSessionStorage({ ...input, sessionId: "gateway-chat-dir" }).chatDir;
    },
    createSessionStorage: createStorage,
    ...(options.store.list
      ? {
          listSessions: async (input: GatewayNativeProjectStorageInput & { limit?: number; offset?: number }) => {
            const records = await options.store.list!({
              projectRoot: input.projectRoot,
              pilotHome: input.pilotHome,
            });
            const sessions = await Promise.all(records.map(async (record) => {
              const storage = createStorage({ ...input, sessionId: record.sessionId });
              const readResult = await storage.readTranscript!();
              return projectSessionInfo(record, readResult);
            }));
            const offset = Math.max(0, input.offset ?? 0);
            const limit = input.limit ?? sessions.length;
            return sessions
              .filter((session): session is SessionInfo => session !== undefined)
              .sort((left, right) => right.lastModified - left.lastModified)
              .slice(offset, limit === 0 ? undefined : offset + limit);
          },
        }
      : {}),
  };
}

function collectToolResultArtifactNames(
  entry: AgentTranscriptEntry,
  sourceToolResultsDir: string,
  names: Set<string>,
): void {
  const messages = entry.type === "accepted_input"
    ? entry.messages
    : entry.type === "assistant_message" || entry.type === "tool_result_message" || entry.type === "durable_message"
      ? [entry.message]
      : [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result_reference" && block.type !== "media_reference") continue;
      const path = resolve(block.path);
      const rel = relative(sourceToolResultsDir, path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || dirname(rel) !== ".") continue;
      names.add(basename(path));
    }
  }
}

function cloneReadResult(result: AgentTranscriptReadResult): AgentTranscriptReadResult {
  return {
    entries: result.entries.map((entry) => structuredClone(entry)),
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function projectSessionInfo(
  record: GatewayAsyncTranscriptSession,
  transcript: AgentTranscriptReadResult,
): SessionInfo | undefined {
  if (transcript.entries.length === 0 || transcript.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return undefined;
  }
  const replay = replayTranscriptEntries(transcript.entries);
  const metadata = replay.metadata;
  const prompts = transcript.entries
    .filter((entry): entry is Extract<AgentTranscriptEntry, { type: "accepted_input" }> => entry.type === "accepted_input")
    .flatMap((entry) => entry.messages)
    .flatMap((message) => message.content)
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean);
  const firstPrompt = prompts[0];
  const lastPrompt = prompts.at(-1);
  const summary = metadata.title?.trim() || metadata.aiTitle?.trim() || lastPrompt || firstPrompt;
  if (!summary) return undefined;
  const firstEntry = transcript.entries[0];
  return {
    sessionId: record.sessionId,
    summary,
    lastModified: record.lastModified,
    fileSize: record.fileSize,
    customTitle: metadata.title,
    aiTitle: metadata.aiTitle,
    firstPrompt,
    tag: metadata.tag,
    createdAt: firstEntry ? Date.parse(firstEntry.createdAt) : undefined,
    parentSessionId: metadata.parentSessionId,
    forkedFromTurnId: metadata.forkedFromTurnId,
  };
}
