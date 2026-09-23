import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckWriteSnapshotMap,
} from "../../tool/index.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { SubagentDefinition } from "./builtinSubagentTypes.js";
import type { CanonicalAssistantTextSummary } from "./types.js";
import type { SubagentDescriptorData } from "./SubagentDescriptor.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { SessionEventDraft } from "../../session/events/SessionEventStore.js";

/**
 * Minimal sidechain writer surface owned by the parent session. Providers may
 * use it to persist child input and durable messages without depending on the
 * session storage implementation.
 */
export type SidechainTranscriptWriter = {
  /** Appends a child-owned durable event to the sidechain session log. */
  recordSessionEvent?(
    sessionId: string,
    turnId: string,
    event: SessionEventDraft,
  ): void | Promise<void>;
  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): void | Promise<void>;
  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void>;
  /** Writes the one-shot child terminal fact when the host persists it. */
  recordTurnResult?(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void>;
  /** Native artifact path for legacy transcript links; opaque to providers. */
  transcriptRelativePath?: string;
  /**
   * Releases child storage after the run settles. The one-shot port owns this
   * call; providers and SubAgentSession must treat the writer as borrowed.
   */
  dispose?(): void | Promise<void>;
};

/** Provider-neutral request for one bounded subagent run. */
export type SubagentRunRequest = {
  definition: SubagentDefinition;
  directive: string;
  parentConfig: AgentRuntimeConfig;
  parentDependencies: AgentRuntimeDependencies;
  parentReadFileState?: PilotDeckReadFileStateMap;
  parentWriteSnapshots?: PilotDeckWriteSnapshotMap;
  parentSessionId: string;
  parentTurnId: string;
  workspaceId?: string;
  storageConfigVersion?: string;
  invocationLogSink?: import("../../storage/legalDataStorage.js").ModelInvocationLogSink;
  parentToolCallId?: string;
  subagentSessionId: string;
  subagentId: string;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /** Read-only activity tap used by the native observer composition. */
  onActivity?: (event: import("../protocol/events.js").AgentEvent) => void;
  sidechainTranscript?: SidechainTranscriptWriter;
  mode?: "one-shot" | "continuable";
};

/** Provider-facing request after the service resolves durable child identity. */
export type ResolvedSubagentRunRequest = SubagentRunRequest & {
  descriptor: SubagentDescriptorData;
};

export type SubagentReport = {
  subagentId: string;
  definitionId: string;
  markdown: string;
  parsed?: CanonicalAssistantTextSummary;
  usage: CanonicalUsage;
  turns: number;
  durationMs: number;
};

export type SubagentProviderCapabilities = {
  continuation: boolean;
  depthLimit: boolean;
  toolFilter: boolean;
};

/** Preparation-only request for a continuable child whose lifecycle belongs to a manager. */
export type ContinuableSubagentPrepareRequest = {
  subagentSessionId: string;
  parentSessionId: string;
  definition: SubagentDefinition;
  parentConfig: AgentRuntimeConfig;
  parentDependencies: AgentRuntimeDependencies;
  abortSignal?: AbortSignal;
};

/** Detached provider contribution; it deliberately contains no live Agent or handle. */
export type ContinuableSubagentCreateSpec = {
  seedEntries?: readonly AgentTranscriptEntry[];
};

export type SubagentRunHandle = {
  result: Promise<SubagentReport>;
  dispose(reason?: unknown): Promise<void>;
};

/** Named delegation provider, aligned with DSH's start/run ownership seam. */
export type SubagentProvider = {
  readonly name: string;
  readonly capabilities: SubagentProviderCapabilities;
  start?(request: ResolvedSubagentRunRequest): Promise<SubagentRunHandle>;
  /** Compatibility adapter for providers that do not expose a run handle. */
  run?(request: ResolvedSubagentRunRequest): Promise<SubagentReport>;
  /** Optional preparation capability. A continuation manager owns everything after this call. */
  prepareContinuable?(
    request: ContinuableSubagentPrepareRequest,
  ): Promise<ContinuableSubagentCreateSpec>;
  dispose?(): void | Promise<void>;
};

/** Native in-process provider factory. The implementation is kept in the
 * compatibility session facade so existing direct callers retain behavior. */
export function createNativeSubagentProvider(): SubagentProvider {
  return {
    name: "pilotdeck-native",
    capabilities: {
      continuation: true,
      depthLimit: true,
      toolFilter: true,
    },
    prepareContinuable: async () => ({}),
    start: async (request) => {
      const { SubAgentSession } = await import("./SubAgentSession.js");
      const result = new SubAgentSession({
        ...request,
        parentDependencies: {
          ...request.parentDependencies,
          subagentProvider: undefined,
          subagentProviders: undefined,
        },
      }).runNative(request.descriptor);
      return {
        result,
        dispose: async () => undefined,
      };
    },
  };
}
