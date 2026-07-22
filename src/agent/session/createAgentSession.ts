import { PermissionRuntime } from "../../permission/index.js";
import { ConcurrentToolScheduler, SequentialToolScheduler, ToolRuntime } from "../../tool/index.js";
import { AgentLoop, type AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { InMemoryTranscriptWriter } from "../../session/transcript/InMemoryTranscriptWriter.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { SessionMetadataStore } from "../../session/metadata/SessionMetadataStore.js";
import type { SessionTitleGenerator } from "../../session/title/SessionTitleGenerator.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import { TurnRunner } from "../turn/TurnRunner.js";
import { AgentSession } from "./AgentSession.js";
import { createAgentEventBuffer, type AgentEvent } from "../protocol/events.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../../session/storage/ProjectSessionStorage.js";

export type CreateAgentSessionOptions = {
  sessionId: string;
  config: AgentRuntimeConfig;
  dependencies: Omit<AgentRuntimeDependencies, "tools"> & {
    tools: Partial<AgentRuntimeDependencies["tools"]> & Pick<AgentRuntimeDependencies["tools"], "registry">;
  };
  transcript?: AgentTranscriptWriter;
  storage?: AgentProjectSessionStorage;
  projectStorage?: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  initialState?: AgentSessionStateShape;
  seedState?: AgentLoopSeedState;
  replayEvents?: AgentEvent[];
  sessionTitleGenerator?: SessionTitleGenerator;
  initialMetadata?: SessionMetadataValue;
  /** Whether Agent-created or modified workspace files should become message artifacts. */
  collectFileArtifacts?: boolean;
};

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  return createAgentSessionWithStorage(options).session;
}

export function createAgentSessionWithStorage(options: CreateAgentSessionOptions): {
  session: AgentSession;
  storage?: AgentProjectSessionStorage;
} {
  const eventBuf = options.dependencies.drainEvents ? undefined : createAgentEventBuffer();
  const emitter = options.dependencies.eventEmitter ?? eventBuf?.emitter;
  const toolRuntime = new ToolRuntime(options.dependencies.tools.registry, new PermissionRuntime(), options.dependencies.lifecycle, emitter);
  const scheduler = options.dependencies.tools.scheduler
    ?? new ConcurrentToolScheduler(toolRuntime, options.dependencies.tools.registry);
  const dependencies: AgentRuntimeDependencies = {
    ...options.dependencies,
    tools: {
      registry: options.dependencies.tools.registry,
      scheduler,
    },
    eventEmitter: emitter,
    drainEvents: options.dependencies.drainEvents ?? eventBuf?.drain,
  };
  const loop = new AgentLoop(options.config, dependencies, options.seedState);
  const storage = options.storage ?? (
    options.projectStorage
      ? createAgentProjectSessionStorage({
          ...options.projectStorage,
          sessionId: options.sessionId,
          now: dependencies.now,
        })
      : undefined
  );
  const transcript = options.transcript ?? storage?.transcript ?? new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId: options.sessionId,
    now: dependencies.now,
  });
  if (options.initialMetadata) {
    metadataStore.restoreFromReplay(options.initialMetadata);
  }
  const runtimeContext = {
    cwd: options.config.cwd,
    transcriptPath: storage?.transcriptPath ?? "",
    collectFileArtifacts: options.collectFileArtifacts ?? true,
  };
  const turnRunner = new TurnRunner(
    loop,
    transcript,
    undefined,
    dependencies.now,
    dependencies.lifecycle,
    runtimeContext,
    {
      metadataStore,
      sessionTitleGenerator: options.sessionTitleGenerator,
      autoGenerateSessionTitle: options.config.isSubagent !== true,
    },
  );
  return {
    session: new AgentSession({
      sessionId: options.sessionId,
      turnRunner,
      cwd: runtimeContext.cwd,
      transcriptPath: runtimeContext.transcriptPath,
      uuid: dependencies.uuid,
      initialState: options.initialState,
      replayEvents: options.replayEvents,
      lifecycle: dependencies.lifecycle,
    }),
    storage,
  };
}
