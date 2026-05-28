import { createAgentSessionStateFromReplay, type AgentSession } from "../../agent/session/AgentSession.js";
import { createAgentSessionWithStorage, type CreateAgentSessionOptions } from "../../agent/session/createAgentSession.js";
import type { AgentRuntimeDependencies } from "../../agent/runtime/AgentRuntimeDependencies.js";
import type { SessionMetadataValue } from "../transcript/TranscriptEntry.js";
import { SessionMetadataStore } from "../metadata/SessionMetadataStore.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../storage/ProjectSessionStorage.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../transcript/TranscriptReplay.js";

/**
 * Optional hook fired once the per-session `storage` has been created. Lets
 * the caller (e.g. `createLocalGateway`) attach per-session runtime pieces
 * that depend on session-scoped paths or the JSONL transcript writer
 * (ToolResultBudget, FileHistoryStore, sidechain hooks, etc.).
 *
 * The returned object is shallow-merged into `options.dependencies`, with
 * the sub-fields of `tools` and `context` handled specially:
 *   - `context` overrides the runtime entirely (caller passes the upgraded
 *     `DefaultContextRuntime` with the freshly-created `toolResultBudget`).
 *   - `fileHistory` / `subagentTranscript` are forwarded as-is.
 */
export type ResumeSessionDependencyExtension = (
  storage: AgentProjectSessionStorage,
) => Partial<
  Pick<
    AgentRuntimeDependencies,
    "context" | "fileHistory" | "subagentTranscript" | "elicitation" | "eventEmitter" | "drainEvents" | "planFileManager" | "planTodoManager"
  >
>;

export type ResumeAgentSessionOptions = Omit<CreateAgentSessionOptions, "transcript" | "projectStorage"> & {
  projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  /** @see `ResumeSessionDependencyExtension`. */
  extendDependencies?: ResumeSessionDependencyExtension;
};

export type ResumeAgentSessionResult = {
  session: AgentSession;
  transcriptPath: string;
  diagnostics: ReturnType<typeof replayTranscriptEntries>["diagnostics"];
  metadata: SessionMetadataValue;
};

export async function resumeAgentSession(options: ResumeAgentSessionOptions): Promise<ResumeAgentSessionResult> {
  const storage = createAgentProjectSessionStorage({
    ...options.projectStorage,
    sessionId: options.sessionId,
    now: options.dependencies.now,
  });
  const readResult = await readTranscript(storage.transcriptPath);

  if (readResult.entries.length > 0) {
    const maxSeq = readResult.entries.reduce((m, e) => Math.max(m, e.sequence), 0);
    const last = readResult.entries[readResult.entries.length - 1];
    storage.transcript.restoreState(maxSeq, last.entryId ?? null);
  }

  const replay = replayTranscriptEntries(readResult.entries);

  const extension = options.extendDependencies?.(storage) ?? {};
  const dependencies: typeof options.dependencies = {
    ...options.dependencies,
    ...(extension.context ? { context: extension.context } : {}),
    ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
    ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
    ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
    ...(extension.eventEmitter ? { eventEmitter: extension.eventEmitter } : {}),
    ...(extension.drainEvents ? { drainEvents: extension.drainEvents } : {}),
    ...(extension.planFileManager ? { planFileManager: extension.planFileManager } : {}),
    ...(extension.planTodoManager ? { planTodoManager: extension.planTodoManager } : {}),
  };

  const { session } = createAgentSessionWithStorage({
    ...options,
    dependencies,
    projectStorage: options.projectStorage,
    transcript: storage.transcript,
    initialState: createAgentSessionStateFromReplay(options.sessionId, replay),
    replayEvents: replay.events,
  });

  // Restore metadata into a SessionMetadataStore so downstream code
  // (adapter / listing) sees the latest state without rescanning.
  const metadataStore = new SessionMetadataStore({
    transcript: storage.transcript,
    sessionId: options.sessionId,
    now: options.dependencies.now,
  });
  metadataStore.restoreFromReplay(replay.metadata);

  return {
    session,
    transcriptPath: storage.transcriptPath,
    diagnostics: [...readResult.diagnostics, ...replay.diagnostics],
    metadata: metadataStore.getSnapshot(),
  };
}
