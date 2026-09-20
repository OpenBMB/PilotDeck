import { InMemoryTranscriptWriter } from "../../session/transcript/InMemoryTranscriptWriter.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { InMemorySessionEventStore } from "../../session/events/InMemorySessionEventStore.js";
import { createDefaultSessionProjectionRegistry } from "../../session/projection/BuiltinSessionProjections.js";
import { SessionProjectionDriver } from "../../session/projection/SessionProjectionDriver.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../../session/storage/ProjectSessionStorage.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { AgentRuntimeScope } from "../scope/AgentRuntimeScope.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { AgentSessionState } from "../protocol/state.js";
import { createAgentEventBuffer } from "../protocol/events.js";
import { createDurableModelInvokerPort } from "../modules/llm/durableModelInvokerPort.js";
import { createRouterModelInvokerPort } from "../modules/llm/routerModelInvokerAdapter.js";
import { createDurableToolPort } from "../modules/capability/durableToolPort.js";
import { createToolSchedulerPort } from "../modules/capability/toolSchedulerAdapter.js";
import {
  createDurableContextRuntime,
  unwrapDurableContextRuntime,
} from "../modules/context/durableContextRuntime.js";
import { createDurableElicitationChannel } from "../modules/interaction/durableElicitationChannel.js";
import {
  createDurablePermissionAuditRecorder,
  unwrapDurablePermissionAuditRecorder,
} from "../modules/permission/durablePermissionAudit.js";
import { AgentSessionEventRecorder } from "./AgentSessionEventRecorder.js";
import {
  AgentSessionScopeBundle,
  type AgentSessionScopeBundleDependencies,
} from "./AgentSessionScopeBundle.js";
import { createNativeOneShotSubagentPort } from "../sub/OneShotSubagentPort.js";
import {
  createAgentTurnContextPort,
  createLifecycleDispatchPort,
  type AgentTurnCapabilities,
} from "../loop/AgentTurnCapabilities.js";
import { createAgentTurnCapabilities } from "../loop/nativeAgentTurnCapabilitiesAdapter.js";
import { SessionAgentLoopOperationLedger } from "../modules/transport/sessionOperationLedger.js";
import {
  createSidecarModuleComposition,
  type SidecarModuleComposition,
  type SidecarTransportContext,
} from "../modules/transport/sidecarHostModulePorts.js";
import { composeToolPorts, createRuntimeModulePorts } from "../../composition/runtimePorts.js";

/**
 * Inputs used to compose the native resources consumed by one AgentSession.
 *
 * This is deliberately an application/runtime composition boundary, not an
 * AgentLoop dependency bag. Callers may inject a scope, storage, ports, or
 * providers they already own; native defaults are created only when absent.
 */
export type AgentSessionRuntimeBundleOptions = {
  sessionId: string;
  config: AgentRuntimeConfig;
  dependencies: AgentSessionScopeBundleDependencies;
  transcript?: AgentTranscriptWriter;
  projections?: SessionProjectionDriver;
  storage?: AgentProjectSessionStorage;
  projectStorage?: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  initialState?: AgentSessionState;
  initialMetadata?: SessionMetadataValue;
  restoredEntries?: readonly AgentTranscriptEntry[];
  /** Transfers an injected scope to the session handle's disposal boundary. */
  ownedScope?: boolean;
  /** Transfers a session-created scoped tool registry to the scope. */
  ownedToolRegistry?: boolean;
  /** Transfers a native reconnect provider to the session scope. */
  ownedInteractionReconnect?: boolean;
};

export type AgentSessionRuntimeResources = {
  storage?: AgentProjectSessionStorage;
  transcript: AgentTranscriptWriter;
  projections?: SessionProjectionDriver;
  scope: AgentRuntimeScope;
  context: AgentRuntimeDependencies["context"];
  dependencies: AgentRuntimeDependencies;
  capabilities: AgentTurnCapabilities;
  sidecarModules: SidecarModuleComposition;
  eventRecorder: AgentSessionEventRecorder;
  sidecarTransportContext: SidecarTransportContext;
  dispose(): Promise<void>;
};

/**
 * Native provider for the resources surrounding an AgentSession.
 *
 * It owns exactly the resources it creates: a root scope when no scope is
 * injected, the in-memory projection driver it creates, and the supplied or
 * newly-created project storage. Scope-owned services retain their existing
 * ownership flags. AgentLoop execution and session publication remain with
 * createAgentSession.
 */
export class AgentSessionRuntimeBundle {
  constructor(private readonly options: AgentSessionRuntimeBundleOptions) {}

  compose(onRollback?: (rollback: Promise<void>) => void): AgentSessionRuntimeResources {
    let ownsScope = false;
    let scope: AgentRuntimeScope | undefined;
    let storage: AgentProjectSessionStorage | undefined;
    let projections: SessionProjectionDriver | undefined;
    let ownsProjections = false;
    try {
      const eventBuf = this.options.dependencies.drainEvents ? undefined : createAgentEventBuffer();
      const emitter = this.options.dependencies.eventEmitter ?? eventBuf?.emitter;
      storage = this.options.storage ?? (
        this.options.projectStorage
          ? createAgentProjectSessionStorage({
              ...this.options.projectStorage,
              sessionId: this.options.sessionId,
              now: this.options.dependencies.now,
            })
          : undefined
      );
      let transcript = this.options.transcript ?? storage?.transcript;
      projections = this.options.projections
        ?? (storage && transcript === storage.transcript ? storage.projections : undefined);
      if (!transcript) {
        const events = new InMemorySessionEventStore({
          now: this.options.dependencies.now,
          uuid: this.options.dependencies.uuid,
        });
        transcript = new InMemoryTranscriptWriter({ eventStore: events });
        if (!this.options.initialState && !this.options.initialMetadata) {
          projections = new SessionProjectionDriver({
            runtime: events,
            registry: createDefaultSessionProjectionRegistry(),
          });
          ownsProjections = true;
        }
      }
      const eventRecorder = new AgentSessionEventRecorder(transcript, {
        restoredEntries: this.options.restoredEntries,
        uuid: this.options.dependencies.uuid,
      });
      const sidecarOperationLedger = new SessionAgentLoopOperationLedger({
        sessionId: this.options.sessionId,
        transcript,
        restoredEntries: this.options.restoredEntries,
      });
      const sidecarTransportContext: SidecarTransportContext = Object.freeze({
        operationLedger: sidecarOperationLedger,
      });
      const auditRecorder = createDurablePermissionAuditRecorder(
        unwrapDurablePermissionAuditRecorder(this.options.dependencies.auditRecorder),
        eventRecorder,
        { sessionId: this.options.sessionId },
      );
      const externalPorts = createRuntimeModulePorts(this.options.config.moduleBindings, this.options.sessionId);
      const selectedContext = externalPorts.context ?? this.options.dependencies.context;
      const context = selectedContext
        ? createDurableContextRuntime(
            unwrapDurableContextRuntime(selectedContext),
            eventRecorder,
          )
        : undefined;
      const elicitation = this.options.dependencies.elicitation
        ? createDurableElicitationChannel(this.options.dependencies.elicitation, eventRecorder, {
            sessionId: this.options.sessionId,
            uuid: this.options.dependencies.uuid,
          })
        : undefined;
      const sessionScope = new AgentSessionScopeBundle({
        sessionId: this.options.sessionId,
        dependencies: this.options.dependencies,
        context,
        elicitation,
        eventEmitter: emitter,
        ownedScope: this.options.ownedScope,
        ownedToolRegistry: this.options.ownedToolRegistry,
        ownedInteractionReconnect: this.options.ownedInteractionReconnect,
      }).compose();
      scope = sessionScope.scope;
      ownsScope = sessionScope.ownsScope;
      const scopedElicitation = scope.services.elicitation ?? elicitation;
      const scopedLifecycle = scope.services.lifecycle ?? this.options.dependencies.lifecycle;
      const modelPort = externalPorts.model ?? this.options.dependencies.ports?.model ?? createRouterModelInvokerPort(
        this.options.dependencies.router,
        {
          isMainAgent: !this.options.config.isSubagent,
          projectPath: this.options.config.cwd,
          fallbackModels: this.options.config.fallbackModels,
          managedModelPolicy: this.options.config.managedModelPolicy,
        },
      );
      const nativeToolPort = this.options.dependencies.ports?.tools ?? createToolSchedulerPort(
        this.options.dependencies.tools.registry,
        sessionScope.scheduler,
      );
      const toolPort = externalPorts.tools
        ? composeToolPorts(externalPorts.tools, nativeToolPort)
        : nativeToolPort;
      const durableModelPort = createDurableModelInvokerPort(modelPort, eventRecorder);
      const durableToolPort = createDurableToolPort(toolPort, eventRecorder);
      const dependencies: AgentRuntimeDependencies = {
        ...this.options.dependencies,
        scope,
        context,
        elicitation: scopedElicitation,
        permission: sessionScope.permission,
        interactionPolicy: scope.services.interactionPolicy ?? sessionScope.interactionPolicy,
        interactionDeadlinePolicy: scope.services.interactionDeadlinePolicy ?? sessionScope.interactionDeadlinePolicy,
        interactionReconnect: scope.services.interactionReconnect ?? sessionScope.interactionReconnect,
        lifecycle: scopedLifecycle,
        ...(scope.services.subagentProvider ?? sessionScope.subagentProvider
          ? { subagentProvider: scope.services.subagentProvider ?? sessionScope.subagentProvider }
          : {}),
        subagentProviders: scope.services.subagentProviders ?? sessionScope.subagentProviders,
        ownedSubagentProvider: sessionScope.ownedSubagentProvider,
        tools: {
          registry: this.options.dependencies.tools.registry,
          scheduler: sessionScope.scheduler,
        },
        ports: {
          ...this.options.dependencies.ports,
          model: durableModelPort,
          tools: durableToolPort,
        },
        eventEmitter: emitter,
        drainEvents: this.options.dependencies.drainEvents ?? eventBuf?.drain,
        auditRecorder,
        sidecarOperationLedger,
      };
      dependencies.oneShotSubagentPort ??= createNativeOneShotSubagentPort({
        config: this.options.config,
        dependencies,
      });
      const capabilities = createAgentTurnCapabilities(this.options.config, dependencies);
      const sidecarModules = createSidecarModuleComposition({
        model: durableModelPort,
        routing: capabilities.model.routing,
        metadata: capabilities.model.metadata,
        budget: capabilities.model.budget,
        toolExecution: durableToolPort,
        permission: sessionScope.permission,
        ...(context ? { context: createAgentTurnContextPort(context) } : {}),
        ...(scopedLifecycle ? { lifecycle: createLifecycleDispatchPort(scopedLifecycle) } : {}),
        eventEmitter: emitter,
        drainEvents: this.options.dependencies.drainEvents ?? eventBuf?.drain,
        auxiliaryModel: capabilities.model.auxiliary,
        interaction: {
          elicitation: scopedElicitation,
          userDialog: this.options.dependencies.userDialog,
        },
        planMode: {
          planFileManager: this.options.dependencies.planFileManager,
          planTodoManager: this.options.dependencies.planTodoManager,
        },
        subagent: { oneShot: dependencies.oneShotSubagentPort },
        goal: this.options.dependencies.goalManager,
        toolRuntimeServices: {
          auditRecorder,
          fileHistory: this.options.dependencies.fileHistory,
          fileUpdateNotifier: this.options.dependencies.fileUpdateNotifier,
        },
        clock: { now: this.options.dependencies.now },
      });
      let disposePromise: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        disposePromise ??= disposeAgentSessionRuntimeResources({
          storage,
          scope,
          ownsScope,
          projections,
          ownsProjections,
        });
        return disposePromise;
      };
      return {
        storage,
        transcript,
        projections,
        scope,
        context,
        dependencies,
        capabilities,
        sidecarModules,
        eventRecorder,
        sidecarTransportContext,
        dispose,
      };
    } catch (error) {
      const rollback = disposeAgentSessionRuntimeResources({
        storage,
        scope,
        ownsScope,
        projections,
        ownsProjections,
      });
      if (onRollback) {
        onRollback(rollback);
      } else {
        void rollback.catch(() => undefined);
      }
      throw error;
    }
  }
}

async function disposeAgentSessionRuntimeResources(input: {
  storage?: AgentProjectSessionStorage;
  scope?: AgentRuntimeScope;
  ownsScope: boolean;
  projections?: SessionProjectionDriver;
  ownsProjections: boolean;
}): Promise<void> {
  const results = await Promise.allSettled([
    input.storage ? input.storage.dispose() : Promise.resolve(),
    input.ownsScope && input.scope ? input.scope.dispose() : Promise.resolve(),
    input.ownsProjections && input.projections
      ? Promise.resolve(input.projections.dispose())
      : Promise.resolve(),
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to dispose agent session runtime resources.");
  }
}
