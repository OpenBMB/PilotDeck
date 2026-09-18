import { AgentLoop, type AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { AgentLoopRuntimeFactory } from "../loop/AgentLoopRuntimeFactory.js";
import { AGENT_TRANSCRIPT_PROJECTION_NAMES } from "../../session/projection/AgentTranscriptProjections.js";
import { requireSessionProjectionValue } from "../../session/projection/SessionProjection.js";
import { SessionMetadataStore } from "../../session/metadata/SessionMetadataStore.js";
import type { SessionTitleGenerator } from "../../session/title/SessionTitleGenerator.js";
import type { SessionTitlePort } from "../../session/title/SessionTitlePort.js";
import type { PromptSuggestionGenerator } from "../../session/prompt/PromptSuggestionGenerator.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import { TurnRunner, type AgentLoopRunner } from "../turn/TurnRunner.js";
import { TurnInputProcessor } from "../turn/TurnInputProcessor.js";
import type { AgentInputAdmission } from "../turn/InputAdmission.js";
import { AgentHandle } from "../scope/AgentHandle.js";
import type { AgentRuntimeScope } from "../scope/AgentRuntimeScope.js";
import { AgentSession } from "./AgentSession.js";
import { ManualCompactionController } from "./ManualCompactionController.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentProjectSessionStorage } from "../../session/storage/ProjectSessionStorage.js";
import {
  AgentSessionRuntimeBundle,
  type AgentSessionRuntimeBundleOptions,
  type AgentSessionRuntimeResources,
} from "./AgentSessionRuntimeBundle.js";

export type CreateAgentSessionOptions = AgentSessionRuntimeBundleOptions & {
  seedState?: AgentLoopSeedState;
  replayEvents?: AgentEvent[];
  /** Application-selected session-title provider. */
  sessionTitleProvider?: SessionTitlePort;
  /** @deprecated Use sessionTitleProvider. */
  sessionTitleGenerator?: SessionTitleGenerator;
  /** Gateway-owned generator used only for SDK sessions that opt in. */
  promptSuggestionGenerator?: PromptSuggestionGenerator;
  /**
   * Session-scoped input admission derived from the frozen extension snapshot.
   * Omitted direct sessions retain the native plain-text processor.
   */
  inputProcessor?: AgentInputAdmission;
  /** Whether Agent-created or modified workspace files should become message artifacts. */
  collectFileArtifacts?: boolean;
  /** @internal Binds unpublished host resources after the exact handle exists. */
  __configure?: (input: AgentSessionConfigureContext) => AgentSessionDisposer | void;
  /**
   * Application-selected external loop provider. It receives only the
   * capability view and is the supported path for a sidecar deployment.
   */
  agentLoopFactory?: AgentLoopRuntimeFactory;
  /**
   * @internal Test-only bypass for exercising composition around a synthetic
   * runner. It is intentionally not an external-loop integration contract.
   */
  __agentLoopFactory?: (input: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
    seedState?: AgentLoopSeedState;
  }) => AgentLoopRunner;
};

export type AgentSessionDisposer = () => void | Promise<void>;

export type AgentSessionConfigureContext = {
  handle: AgentHandle;
  session: AgentSession;
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
  scope: AgentRuntimeScope;
  storage?: AgentProjectSessionStorage;
};

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  return createAgentSessionWithStorage(options).session;
}

export type CreatedAgentSession = {
  session: AgentSession;
  handle: AgentHandle;
  storage?: AgentProjectSessionStorage;
};

export function createAgentSessionWithStorage(options: CreateAgentSessionOptions): CreatedAgentSession {
  return buildAgentSession(options);
}

export async function createAgentSessionWithStorageAsync(
  options: CreateAgentSessionOptions,
): Promise<CreatedAgentSession> {
  let rollback: Promise<void> | undefined;
  try {
    return buildAgentSession(options, (pendingRollback) => {
      rollback = pendingRollback;
    });
  } catch (error) {
    if (rollback) {
      try {
        await rollback;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Failed to create and roll back agent session resources.",
        );
      }
    }
    throw error;
  }
}

function buildAgentSession(
  options: CreateAgentSessionOptions,
  onRollback?: (rollback: Promise<void>) => void,
): CreatedAgentSession {
  let resources: AgentSessionRuntimeResources | undefined;
  let configuredDisposer: AgentSessionDisposer | undefined;
  try {
    const runtimeResources = new AgentSessionRuntimeBundle(options).compose(onRollback);
    resources = runtimeResources;
    const { capabilities, context, dependencies, eventRecorder, projections, scope, storage, transcript, sidecarModules, sidecarTransportContext } = runtimeResources;
    const loop = options.__agentLoopFactory?.({
      config: options.config,
      dependencies,
      seedState: options.seedState,
    }) ?? options.agentLoopFactory?.({
      config: options.config,
      capabilities,
      sidecarModules,
      seedState: options.seedState,
      sidecarTransportContext,
    }) ?? new AgentLoop(options.config, capabilities, options.seedState);
    const metadataStore = new SessionMetadataStore({
      transcript,
      sessionId: options.sessionId,
      now: dependencies.now,
    });
    const initialMetadata = options.initialMetadata ?? (projections
      ? requireSessionProjectionValue<SessionMetadataValue>(
          projections.snapshot([AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata]),
          AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
        )
      : undefined);
    if (initialMetadata) {
      metadataStore.restoreFromReplay(initialMetadata);
    }
    const runtimeContext = {
      cwd: options.config.cwd,
      transcriptPath: storage?.transcriptPath ?? "",
      collectFileArtifacts: options.collectFileArtifacts ?? true,
    };
    const turnRunner = new TurnRunner(
      loop,
      transcript,
      new TurnInputProcessor(options.inputProcessor),
      dependencies.now,
      dependencies.lifecycle,
      runtimeContext,
      {
        metadataStore,
        sessionTitleProvider: options.sessionTitleProvider,
        sessionTitleGenerator: options.sessionTitleGenerator,
        promptSuggestionGenerator: options.promptSuggestionGenerator,
        autoGenerateSessionTitle: options.config.isSubagent !== true,
        eventRecorder,
      },
    );
    let session!: AgentSession;
    const manualCompactionController = new ManualCompactionController({
      sessionId: options.sessionId,
      context,
      recorder: eventRecorder,
      transcript,
      messages: () => session.snapshot().messages,
      now: dependencies.now,
      uuid: dependencies.uuid,
    });
    session = new AgentSession({
      sessionId: options.sessionId,
      turnRunner,
      cwd: runtimeContext.cwd,
      transcriptPath: runtimeContext.transcriptPath,
      uuid: dependencies.uuid,
      initialState: options.initialState,
      replayEvents: options.replayEvents,
      lifecycle: dependencies.lifecycle,
      eventRecorder,
      projections,
      restoredEntries: options.restoredEntries,
      manualCompactionController,
    });
    const handle = new AgentHandle(session, {
      uuid: dependencies.uuid,
      onDispose: async () => {
        await disposeAgentSessionLifecycle({
          configuredDisposer,
          resources: runtimeResources,
        });
      },
    });
    configuredDisposer = options.__configure?.({
      handle,
      session,
      config: options.config,
      dependencies,
      scope,
      storage,
    }) ?? undefined;
    return { session, handle, storage };
  } catch (error) {
    if (resources) {
      const rollback = resources.dispose();
      if (onRollback) {
        onRollback(rollback);
      } else {
        void rollback.catch(() => undefined);
      }
    }
    throw error;
  }
}

async function disposeAgentSessionLifecycle(input: {
  configuredDisposer?: AgentSessionDisposer;
  resources: AgentSessionRuntimeResources;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    await input.configuredDisposer?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    await input.resources.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to dispose agent session lifecycle.");
  }
}
