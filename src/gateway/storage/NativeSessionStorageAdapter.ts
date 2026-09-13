import { isAbsolute, resolve } from "node:path";

import { getPilotProjectChatDir } from "../../pilot/index.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../../session/index.js";
import type { SessionInfo } from "../../session/storage/SessionList.js";

/**
 * Immutable context supplied when a Gateway resolves one persistent session
 * storage location. The Gateway, rather than the SDK client, owns this
 * resolution so a remote caller can never select arbitrary host paths.
 */
export type GatewayNativeSessionStorageInput = Readonly<AgentProjectSessionStorageOptions>;
export type GatewayNativeProjectStorageInput = Readonly<Pick<
  AgentProjectSessionStorageOptions,
  "projectRoot" | "pilotHome"
>>;

/**
 * Host hook for choosing the native, filesystem-backed storage layout of a
 * Gateway session.
 *
 * The returned value stays a native `AgentProjectSessionStorage`: transcript
 * semantics, sidechain records, file-history checkpoints, artifact writes,
 * session ownership, resume and deletion all remain implemented by the
 * Gateway. This is deliberately not an SDK event-mirror adapter and not a
 * second session state machine.
 *
 * Hosts may place the native files on an encrypted volume, a per-tenant
 * mount, or another Gateway-local filesystem hierarchy. Async database/object
 * storage requires a separate native transcript/checkpoint implementation and
 * is outside this layout adapter's contract.
 */
export type GatewayNativeSessionStorageAdapter = {
  /** Returns the stable native transcript directory for one Gateway project. */
  getProjectChatDir(input: GatewayNativeProjectStorageInput): string;
  createSessionStorage(input: GatewayNativeSessionStorageInput): AgentProjectSessionStorage;
  /**
   * Optional host-native session lister. Omit it to retain the historical
   * filesystem JSONL scan.
   */
  listSessions?(input: GatewayNativeProjectStorageInput & {
    limit?: number;
    offset?: number;
    includeInternal?: boolean;
  }): Promise<SessionInfo[]>;
};

/**
 * Resolves one native session storage instance. With no adapter it produces
 * the historical PilotDeck project layout exactly as before.
 */
export function createGatewayNativeSessionStorage(
  input: AgentProjectSessionStorageOptions,
  adapter?: GatewayNativeSessionStorageAdapter,
): AgentProjectSessionStorage {
  const normalized: GatewayNativeSessionStorageInput = Object.freeze({ ...input });
  const expectedChatDir = resolveGatewayNativeProjectChatDir(normalized, adapter);
  const storage = adapter
    ? adapter.createSessionStorage(normalized)
    : createAgentProjectSessionStorage(normalized);
  validateNativeSessionStorage(storage, expectedChatDir);
  return storage;
}

/** Resolves the stable native transcript directory without inventing a session id. */
export function resolveGatewayNativeProjectChatDir(
  input: GatewayNativeProjectStorageInput,
  adapter?: GatewayNativeSessionStorageAdapter,
): string {
  const normalized: GatewayNativeProjectStorageInput = Object.freeze({ ...input });
  const chatDir = adapter
    ? adapter.getProjectChatDir(normalized)
    : getPilotProjectChatDir(normalized.projectRoot, normalized.pilotHome);
  if (typeof chatDir !== "string" || !isAbsolute(chatDir)) {
    throw new Error("Gateway nativeSessionStorage adapter returned a non-absolute project chatDir.");
  }
  return resolve(chatDir);
}

function validateNativeSessionStorage(storage: AgentProjectSessionStorage, expectedChatDir: string): void {
  if (!storage || typeof storage !== "object") {
    throw new Error("Gateway nativeSessionStorage adapter must return an AgentProjectSessionStorage object.");
  }
  for (const [label, value] of Object.entries({
    chatDir: storage.chatDir,
    transcriptPath: storage.transcriptPath,
    toolResultsDir: storage.toolResultsDir,
    fileHistoryDir: storage.fileHistoryDir,
    subagentsDir: storage.subagentsDir,
  })) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`Gateway nativeSessionStorage adapter returned a non-absolute ${label}.`);
    }
  }
  if (resolve(storage.chatDir) !== expectedChatDir) {
    throw new Error("Gateway nativeSessionStorage adapter returned a chatDir different from getProjectChatDir().");
  }
  if (typeof storage.subagentTranscriptPath !== "function") {
    throw new Error("Gateway nativeSessionStorage adapter must provide subagentTranscriptPath().");
  }
  const transcript = storage.transcript;
  if (!transcript
    || typeof transcript.recordAcceptedInput !== "function"
    || typeof transcript.recordDurableMessage !== "function"
    || typeof transcript.recordTurnResult !== "function"
    || typeof transcript.recordSessionMetadata !== "function"
    || typeof transcript.recordAgentStatusMessage !== "function"
    || typeof transcript.recordFileSnapshot !== "function"
    || typeof transcript.restoreState !== "function"
    || typeof transcript.forSubagent !== "function"
    || typeof transcript.relativeSubagentPath !== "function"
    || typeof transcript.recordSubagentStarted !== "function"
    || typeof transcript.recordSubagentCompleted !== "function") {
    throw new Error("Gateway nativeSessionStorage adapter must provide a JsonlTranscriptWriter-compatible transcript.");
  }
}
