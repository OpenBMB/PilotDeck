import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { CanonicalContentBlock, CanonicalMessage, CanonicalToolCall } from "../../../model/index.js";
import { HostToolCheckpoint } from "../checkpoint/hostToolCheckpoint.js";
import { parseAgentLoopSeedStateProjection, serializeAgentLoopSeedStateProjection } from "../checkpoint/seedStateProjection.js";
import {
  createDefaultSidecarTurnComposition,
  resolveSidecarTurnCompositionHandlers,
  type SidecarTurnComposition,
  type SidecarTurnCompositionFactory,
} from "./sidecarTurnComposition.js";
import type {
  AgentLoopSidecarTransportObservation,
  AgentLoopSidecarTransportObserver,
} from "./sidecarTransportObserver.js";
import type {
  AgentLoopOperationAccepted,
  AgentLoopOperationIdentity,
  AgentLoopOperationKnownTerminal,
  AgentLoopOperationLedger,
  AgentLoopOperationResolution,
  AgentLoopOperationUnknownTerminal,
} from "./operationLedger.js";
import {
  AgentLoopResultUnknownError,
  isAgentLoopResultUnknownError,
} from "./operationLedger.js";
import type {
  ModuleCapabilities,
  ModuleBinding,
  ModuleCallRequest,
  ModuleEvent,
  ModuleExecuteRequest,
  ModuleHandshakeRequest,
  ModuleMessage,
  ModuleOutcome,
  ModuleResponse,
} from "../protocol.js";
import { MODULE_PROTOCOL_VERSION, validateModuleMessage } from "../protocol.js";
import type { AgentLoopRuntimeFactory } from "../../loop/AgentLoopRuntimeFactory.js";
import {
  parseAgentLoopModelSessionStateProjection,
  serializeAgentLoopModelSessionStateProjection,
  type AgentLoopInput,
  type AgentLoopModelSessionState,
  type AgentLoopRunResult,
  type AgentLoopSeedState,
} from "../../loop/AgentLoop.js";
import { seedAgentReadState } from "../../loop/seedReadState.js";
import { TurnTimeline } from "../../stream/TurnTimeline.js";
import { applyAgentPermissionOverrides } from "../../turn/permissionOverrides.js";
import type { AgentEvent } from "../../protocol/events.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentTurnResult } from "../../protocol/result.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import type { AgentLoopRunner } from "../../turn/TurnRunner.js";
import { createSidecarDefaultModuleDispatcher } from "./sidecarDefaultModuleDispatcher.js";
import {
  createSidecarHostModulePorts,
  createSidecarModuleComposition,
  type SidecarCapabilityModulePort,
  type SidecarContextModulePort,
  type SidecarEventModulePort,
  type SidecarHostModulePorts,
  type SidecarLifecycleModulePort,
  type SidecarModelModulePort,
  type SidecarModuleComposition,
  type SidecarPermissionModulePort,
  type SidecarTransportContext,
  type SidecarTransportTurn,
} from "./sidecarHostModulePorts.js";

/**
 * One bidirectional connection to an AgentLoop sidecar. The application owns
 * process/stdio/socket lifecycle; this client only speaks Module Protocol.
 */
export type AgentLoopSidecarConnection = {
  send(message: ModuleMessage): void | Promise<void>;
  receive(): AsyncIterable<unknown>;
  /**
   * Optional transport-owned replacement connection. Only long-lived
   * transports implement this; the client never respawns or retries execute.
   */
  reconnect?(input: {
    streamId: string;
    previousBinding: ModuleBinding;
    lastAppliedSequence: number;
  }): AgentLoopSidecarConnection | Promise<AgentLoopSidecarConnection>;
  close?(reason?: unknown): void | Promise<void>;
};

/** New sidecar connection contract. It deliberately exposes no aggregate. */
export type SidecarConnectionFactoryInput = {
  turn: SidecarTransportTurn;
  seedState?: AgentLoopSeedState;
  transport: SidecarTransportContext;
};

/** @deprecated Connection providers should use SidecarConnectionFactoryInput. */
export type AgentLoopSidecarConnectionFactoryInput = SidecarConnectionFactoryInput;

export type AgentLoopSidecarConnectionFactory = (
  input: SidecarConnectionFactoryInput,
) => AgentLoopSidecarConnection | Promise<AgentLoopSidecarConnection>;

/**
 * Immutable protocol facts supplied to the host when a sidecar cannot prove
 * an execute terminal. The host owns the operation ledger and may use these
 * values to query it; this client never retries or invents a result.
 */
export type AgentLoopSidecarResultUnknownInput = AgentLoopOperationUnknownTerminal;

/** A host-owned, already reconciled terminal for a result_unknown attempt. */
export type AgentLoopSidecarResultUnknownResolution = AgentLoopOperationResolution;

export type AgentLoopSidecarResultUnknownReconciler = (
  input: AgentLoopSidecarResultUnknownInput,
) => AgentLoopSidecarResultUnknownResolution | undefined | Promise<AgentLoopSidecarResultUnknownResolution | undefined>;

export type AgentLoopSidecarRuntimeFactoryOptions = {
  connect: AgentLoopSidecarConnectionFactory;
  /** Expected descriptor identity selected by deployment composition. */
  expectedModuleId?: string;
  /**
   * Optional host operation-ledger query for a sidecar result_unknown final.
   * Omitting it intentionally keeps result_unknown fail-closed.
   */
  reconcileResultUnknown?: AgentLoopSidecarResultUnknownReconciler;
  /** Optional explicit host ledger. Session composition supplies one by default. */
  operationLedger?: AgentLoopOperationLedger;
  /** Passive deployment telemetry. It cannot affect transport or turn semantics. */
  transportObserver?: AgentLoopSidecarTransportObserver;
  /** Preferred explicit transport/session-owned context. */
  transportContext?: SidecarTransportContext;
  /** Optional host-specific module handlers composed for each sidecar turn. */
  moduleHandlers?: SidecarModuleHandlerFactory;
  /** Optional host observer for capability results. */
  capabilityResultObserver?: SidecarCapabilityResultObserver;
  /** Optional host composition for turn-scoped policy and module callbacks. */
  turnComposition?: SidecarTurnCompositionFactory;
  uuid?: () => string;
};

/** Host composition hook for results returned by a capability provider. */
export type SidecarCapabilityResultObserver = Readonly<{
  onCapabilityResults(results: readonly import("../../../tool/index.js").PilotDeckToolResult[]): void | Promise<void>;
}>;

/** One externally composed host module handler. */
export type SidecarModuleHandler = (call: ModuleCallRequest) => Promise<Record<string, unknown>>;

/**
 * Optional host handler overrides. The protocol supplies defaults for every
 * core module, while Plan/Todo and result observation are composed externally.
 */
export type SidecarModuleHandlerRegistry = Readonly<Partial<{
  model: SidecarModuleHandler;
  budget: SidecarModuleHandler;
  turn: SidecarModuleHandler;
  capability: SidecarModuleHandler;
  permission: SidecarModuleHandler;
  context: SidecarModuleHandler;
  lifecycle: SidecarModuleHandler;
  event: SidecarModuleHandler;
}>>;

export type SidecarModuleHandlerFactory = Readonly<{
  model?: (input: SidecarModelHandlerFactoryInput) => SidecarModuleHandler;
  budget?: (input: SidecarBudgetHandlerFactoryInput) => SidecarModuleHandler;
  turn?: (input: SidecarTurnHandlerFactoryInput) => SidecarModuleHandler;
  capability?: (input: SidecarCapabilityHandlerFactoryInput) => SidecarModuleHandler;
  permission?: (input: SidecarPermissionHandlerFactoryInput) => SidecarModuleHandler;
  context?: (input: SidecarContextHandlerFactoryInput) => SidecarModuleHandler;
  lifecycle?: (input: SidecarLifecycleHandlerFactoryInput) => SidecarModuleHandler;
  event?: (input: SidecarEventHandlerFactoryInput) => SidecarModuleHandler;
}>;

type SidecarModuleTurnIdentity = Readonly<{
  sessionId: string;
  turnId: string;
  runId: string;
  operationId: string;
  operationDeadline?: string;
  abortSignal?: AbortSignal;
}>;

export type SidecarModelHandlerFactoryInput = Readonly<{
  port: SidecarModelModulePort;
  turn: SidecarModuleTurnIdentity & Readonly<{ projectPath: string }>;
}>;
export type SidecarBudgetHandlerFactoryInput = Readonly<{
  port: NonNullable<SidecarModuleComposition["budget"]>;
  turn: SidecarModuleTurnIdentity;
}>;
export type SidecarTurnHandlerFactoryInput = Readonly<{
  turn: SidecarModuleTurnIdentity;
}>;
export type SidecarCapabilityHandlerFactoryInput = Readonly<{
  port: SidecarCapabilityModulePort;
  turn: SidecarModuleTurnIdentity;
}>;
export type SidecarPermissionHandlerFactoryInput = Readonly<{
  port: SidecarPermissionModulePort;
  turn: Pick<SidecarModuleTurnIdentity, "sessionId" | "turnId" | "abortSignal">;
}>;
export type SidecarContextHandlerFactoryInput = Readonly<{
  port: SidecarContextModulePort;
  turn: Pick<SidecarModuleTurnIdentity, "sessionId" | "turnId" | "abortSignal"> & Readonly<{
    cwd: string;
    permissionMode: string;
    runMode: string;
    maxContextTokens?: number;
  }>;
}>;
export type SidecarLifecycleHandlerFactoryInput = Readonly<{
  port: SidecarLifecycleModulePort;
  turn: Pick<SidecarModuleTurnIdentity, "sessionId" | "turnId" | "abortSignal"> & Readonly<{
    cwd: string;
    permissionMode: string;
    environment: NodeJS.ProcessEnv | undefined;
  }>;
}>;
export type SidecarEventHandlerFactoryInput = Readonly<{
  port: SidecarEventModulePort;
  turn: Pick<SidecarModuleTurnIdentity, "sessionId" | "turnId">;
}>;

/**
 * Build the public, capability-only external AgentLoop factory for a
 * Module-Protocol sidecar. It deliberately has no Session, Router, Gateway,
 * scheduler, or persistence dependency.
 */
export function createAgentLoopSidecarRuntimeFactory(
  options: AgentLoopSidecarRuntimeFactoryOptions,
): AgentLoopRuntimeFactory {
  return ({ config, capabilities, sidecarModules, seedState, sidecarTransportContext }) => new AgentLoopSidecarRunner({
    config,
    modules: sidecarModules
      ?? createSidecarModuleComposition(createSidecarHostModulePorts(capabilities)),
    seedState,
    connect: options.connect,
    expectedModuleId: options.expectedModuleId,
    reconcileResultUnknown: options.reconcileResultUnknown,
    operationLedger: options.transportContext?.operationLedger
      ?? sidecarTransportContext?.operationLedger
      ?? options.operationLedger
      // @deprecated Native compatibility fallback. New sidecar composition
      // supplies transportContext explicitly from its session owner.
      ?? capabilities.transport.operationLedger,
    transportObserver: options.transportContext?.transportObserver
      ?? sidecarTransportContext?.transportObserver
      ?? options.transportObserver,
    moduleHandlers: options.moduleHandlers,
    capabilityResultObserver: options.capabilityResultObserver,
    turnComposition: options.turnComposition,
    uuid: options.uuid ?? randomUUID,
  });
}

class AgentLoopSidecarRunner implements AgentLoopRunner {
  private seedState: AgentLoopSeedState | undefined;
  private modelState: AgentLoopModelSessionState | undefined;
  private active = false;
  private readonly turnComposition: SidecarTurnComposition;
  private readonly modules: SidecarModuleComposition;

  constructor(private readonly options: {
    config: AgentRuntimeConfig;
    modules: SidecarModuleComposition;
    seedState?: AgentLoopSeedState;
    connect: AgentLoopSidecarConnectionFactory;
    expectedModuleId?: string;
    reconcileResultUnknown?: AgentLoopSidecarResultUnknownReconciler;
    operationLedger?: AgentLoopOperationLedger;
    transportObserver?: AgentLoopSidecarTransportObserver;
    moduleHandlers?: SidecarModuleHandlerFactory;
    capabilityResultObserver?: SidecarCapabilityResultObserver;
    turnComposition?: SidecarTurnCompositionFactory;
    uuid: () => string;
  }) {
    this.seedState = cloneSeedState(options.seedState);
    this.modules = options.modules;
    this.turnComposition = options.turnComposition?.({
      config: options.config,
      modules: this.modules,
      moduleHandlers: options.moduleHandlers,
      capabilityResultObserver: options.capabilityResultObserver,
    }) ?? createDefaultSidecarTurnComposition({
      config: options.config,
      modules: this.modules,
      moduleHandlers: options.moduleHandlers,
      capabilityResultObserver: options.capabilityResultObserver,
    });
  }

  snapshotFileState(): AgentLoopSeedState {
    return cloneSeedState(this.seedState) ?? {};
  }

  async seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    const state = cloneSeedState(this.seedState) ?? {};
    const mutable = {
      readFileState: state.readFileState ?? new Map(),
      writeSnapshots: state.writeSnapshots ?? new Map(),
      allowedReadFiles: new Set(state.allowedReadFiles ?? []),
    };
    const result = await seedAgentReadState(this.options.config, mutable, filePath, mtimeMs);
    this.seedState = {
      readFileState: mutable.readFileState,
      writeSnapshots: mutable.writeSnapshots,
      allowedReadFiles: [...mutable.allowedReadFiles],
    };
    return result;
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    if (this.active) throw new Error("AgentLoop sidecar runner does not support concurrent turns.");
    this.active = true;
    let connection: AgentLoopSidecarConnection | undefined;
    let protocol: SidecarTurnProtocol | undefined;
    let dispatcher: ReturnType<typeof createSidecarDefaultModuleDispatcher> | undefined;
    let hostToolCheckpoint: HostToolCheckpoint | undefined;
    try {
      // Native AgentLoop applies submit overrides before it evaluates this
      // turn. The host keeps the resulting live policy for later turns too.
      this.applyRunModeOverride(input);
      applyAgentPermissionOverrides(this.options.config, input);
      const turnComposition = this.turnComposition.forTurn(input);
      if (input.abortSignal?.aborted) return abortedResult(input);
      const model = this.modules.model.bindTurn?.({
        sessionId: input.sessionId,
        turnId: input.turnId,
      }) ?? this.modules.model;
      const modules = Object.freeze({ ...this.modules, model });
      // The connection provider and host module dispatcher must observe one
      // immutable checkpoint for this turn. A transport receives its own
      // clone so it cannot alter the host-owned seed used by capability calls.
      const turnSeedState = this.snapshotFileState();
      hostToolCheckpoint = new HostToolCheckpoint(turnSeedState, input.allowedReadFiles);
      dispatcher = createSidecarDefaultModuleDispatcher({
        config: this.options.config,
        modules,
        input,
        checkpoint: hostToolCheckpoint,
        capabilityResultObserver: turnComposition.capabilityResultObserver,
        planTodoHandler: turnComposition.planTodoHandler,
      });
      const moduleHandlers = turnComposition.moduleHandlers
        ?? resolveSidecarTurnCompositionHandlers({
          config: this.options.config,
          modules,
          turn: input,
        }, this.options.moduleHandlers);
      connection = await this.options.connect({
        turn: sidecarTransportTurn(input),
        seedState: cloneSeedState(turnSeedState),
        transport: Object.freeze({
          operationLedger: this.options.operationLedger,
          transportObserver: this.options.transportObserver,
        }),
      });
      const hostEventProjector = new SidecarHostEventProjector(input, () => protocol?.moduleId);
      protocol = new SidecarTurnProtocol({
        config: this.options.config,
        input,
        checkpoint: hostToolCheckpoint,
        manifest: dispatcher.manifest,
        modelState: this.modelState,
        expectedModuleId: this.options.expectedModuleId,
        uuid: this.options.uuid,
        reconcileResultUnknown: this.options.reconcileResultUnknown,
        operationLedger: this.options.operationLedger,
        transportObserver: this.options.transportObserver,
        moduleHandlers: Object.freeze({ ...dispatcher.handlers, ...moduleHandlers }),
        projectTerminal: (terminal) => hostEventProjector.projectTerminal(terminal),
      });
      const iterator = protocol.execute(connection);
      const drainHostEvents = (): AgentEvent[] => hostEventProjector.drain(this.options.modules.event?.drain?.() ?? []);
      let result: SidecarTerminal;
      let pendingNext = iterator.next();
      while (true) {
        const received = await Promise.race([
          pendingNext.then((next) => ({ type: "event" as const, next })),
          sleep(500).then(() => ({ type: "pump" as const })),
        ]);
        if (received.type === "pump") {
          for (const hostEvent of drainHostEvents()) yield hostEvent;
          for (const heartbeat of hostEventProjector.heartbeats()) yield heartbeat;
          continue;
        }
        const next = received.next;
        for (const hostEvent of drainHostEvents()) {
          yield hostEvent;
        }
        if (next.done) {
          result = next.value;
          break;
        }
        const event = hostEventProjector.project(next.value);
        if (event.type === "steer_applied") {
          await input.onDurableMessage?.(event.message);
          dispatcher.applySteerAuthorization(event.itemId);
          input.onSteerApplied?.(event.itemId);
        }
        if (event.type === "agent_status") {
          await input.onAgentStatusMessage?.(sidecarStatusMessage(event));
        }
        yield event;
        if (event.type === "assistant_message" || event.type === "tool_results_projected") {
          await input.onDurableMessage?.(event.message);
        }
        pendingNext = iterator.next();
      }
      this.seedState = result.seedState;
      this.modelState = result.modelState;
      return { result: result.result, messages: result.messages };
    } finally {
      // Tool code is host-owned. Retain its checkpoint even when a later
      // transcript callback rejects; that failure must not erase safe read/
      // write state or change the terminal outcome classification.
      if (hostToolCheckpoint) this.seedState = hostToolCheckpoint.snapshot();
      this.active = false;
      try {
        await protocol?.close("agent_loop_turn_finished") ?? connection?.close?.("agent_loop_turn_finished");
      } finally {
        await dispatcher?.dispose();
      }
    }
  }

  private applyRunModeOverride(input: AgentLoopInput): void {
    // Mirror AgentLoop.applyRunModeOverride(). The host ToolRuntime and
    // lifecycle callbacks cannot treat a sidecar payload as policy authority.
    this.options.config.runMode = input.runMode ?? this.options.config.runMode ?? "agent";
  }
}

type SidecarTerminal = AgentLoopRunResult & {
  seedState?: AgentLoopSeedState;
  modelState?: AgentLoopModelSessionState;
};

type SidecarBinding = {
  moduleId: string;
  moduleInstanceId: string;
  connectionGeneration: string;
  capabilitiesVersion: string;
};

type CachedModuleResponse = {
  call: ModuleCallRequest;
  response: ModuleResponse;
};

/** One host-owned Module Protocol handler. Handlers are composed per turn. */
type SidecarModuleHandlers = Readonly<Partial<{
  model: SidecarModuleHandler;
  budget: SidecarModuleHandler;
  turn: SidecarModuleHandler;
  capability: SidecarModuleHandler;
  permission: SidecarModuleHandler;
  context: SidecarModuleHandler;
  lifecycle: SidecarModuleHandler;
  event: SidecarModuleHandler;
}>>;

/** A new sidecar instance has no authority to replay a prior process's stream. */
class SidecarInstanceRestartedError extends Error {
  constructor() {
    super("Sidecar instance restarted while resuming a stream.");
    this.name = "SidecarInstanceRestartedError";
  }
}

class SidecarTurnProtocol {
  private helloMessageId = "";
  private capabilitiesMessageId = "";
  private readonly executeMessageId: string;
  private readonly runId: string;
  private readonly operationId: string;
  private readonly requestId: string;
  /** Per-turn delivery cache. It is never persisted or shared across runs. */
  private readonly completedModuleResponses = new Map<string, CachedModuleResponse>();
  private streamId: string | undefined;
  private nextSequence = 0;
  private cancelSent = false;
  private cancelRequested = false;
  private supportsCancel = false;
  private supportsResume = false;
  private binding: SidecarBinding | undefined;
  private connectionBinding: SidecarBinding | undefined;
  private connection: AgentLoopSidecarConnection | undefined;
  private reconnectAttempts = 0;
  private pendingResumeBinding: ModuleBinding | undefined;
  private resumeMessageId: string | undefined;
  private reconnectSucceeded = false;
  private reconnectFailureObserved = false;
  private resultUnknownSource: "sidecar_final" | "transport_interruption" | undefined;
  private readonly hostToolCheckpoint: HostToolCheckpoint;
  private readonly manifest: ReturnType<typeof createSidecarDefaultModuleDispatcher>["manifest"];
  private readonly handlers: SidecarModuleHandlers;

  constructor(private readonly options: {
    config: AgentRuntimeConfig;
    input: AgentLoopInput;
    checkpoint: HostToolCheckpoint;
    manifest: ReturnType<typeof createSidecarDefaultModuleDispatcher>["manifest"];
    modelState?: AgentLoopModelSessionState;
    expectedModuleId?: string;
    uuid: () => string;
    reconcileResultUnknown?: AgentLoopSidecarResultUnknownReconciler;
    operationLedger?: AgentLoopOperationLedger;
    transportObserver?: AgentLoopSidecarTransportObserver;
    moduleHandlers: SidecarModuleHandlerRegistry;
    projectTerminal?: (terminal: SidecarTerminal) => SidecarTerminal;
  }) {
    this.hostToolCheckpoint = options.checkpoint;
    this.helloMessageId = `hello-${options.uuid()}`;
    this.capabilitiesMessageId = `capabilities-${options.uuid()}`;
    this.executeMessageId = `execute-${options.uuid()}`;
    this.runId = options.input.execution?.runId ?? `run-${options.uuid()}`;
    this.operationId = options.input.execution?.operationId ?? options.input.turnId;
    this.requestId = `request-${options.uuid()}`;
    this.handlers = options.moduleHandlers;
    this.manifest = options.manifest;
  }

  /** The implementation identity validated during the current sidecar handshake. */
  get moduleId(): string | undefined {
    return this.binding?.moduleId;
  }

  async *execute(connection: AgentLoopSidecarConnection): AsyncGenerator<AgentEvent, SidecarTerminal, unknown> {
    const removeAbortListener = this.linkCancellation();
    let executeStarted = false;
    let terminalObserved = false;
    let phase: "hello" | "capabilities" | "resume" | "execute" = "hello";
    let reconnecting = false;
    this.connection = connection;
    try {
      await this.send(this.handshakeRequest("hello"));
      let iterator = connection.receive()[Symbol.asyncIterator]();
      while (true) {
        let next: IteratorResult<unknown>;
        try {
          next = await iterator.next();
        } catch (error) {
          const replacement = await this.reconnect();
          if (!replacement) throw error;
          reconnecting = true;
          phase = "hello";
          iterator = replacement.receive()[Symbol.asyncIterator]();
          await this.send(this.handshakeRequest("hello"));
          continue;
        }
        if (next.done) {
          const replacement = await this.reconnect();
          if (!replacement) throw new Error("Sidecar connection closed before execute reached a terminal event.");
          reconnecting = true;
          phase = "hello";
          iterator = replacement.receive()[Symbol.asyncIterator]();
          await this.send(this.handshakeRequest("hello"));
          continue;
        }
        const rawMessage = next.value;
        const validation = validateModuleMessage(rawMessage);
        if (!validation.ok) throw new Error(`Invalid sidecar message: ${validation.code}: ${validation.message}`);
        const message = rawMessage as ModuleMessage;
        if (isModuleCall(message)) {
          if (phase !== "execute") throw new Error("Sidecar issued module_call before handshake completed.");
          const replacement = await this.sendModuleResponse(message);
          if (replacement) {
            reconnecting = true;
            phase = "hello";
            iterator = replacement.receive()[Symbol.asyncIterator]();
            await this.send(this.handshakeRequest("hello"));
          }
          continue;
        }
        if (message.kind === "response") {
          if (phase === "hello" || phase === "capabilities") {
            this.acceptHandshakeResponse(message, phase);
            if (phase === "hello") {
              phase = "capabilities";
              await this.send(this.handshakeRequest("capabilities"));
            } else if (reconnecting) {
              reconnecting = false;
              phase = "resume";
              await this.send(this.resumeRequest());
            } else {
              phase = "execute";
              if (this.options.input.abortSignal?.aborted) return abortedResult(this.options.input);
              const recovered = await this.options.operationLedger?.recover?.(this.operationIdentity());
              if (recovered?.state === "terminal") {
                const terminal = readResolvedTerminal(recovered.resolution, this.options.input);
                terminalObserved = true;
                yield {
                  type: "turn_completed",
                  sessionId: this.options.input.sessionId,
                  turnId: this.options.input.turnId,
                  result: terminal.result,
                };
                return terminal;
              }
              if (recovered?.state === "result_unknown") {
                const resolution = await this.options.reconcileResultUnknown?.(recovered.unknown);
                if (!resolution) {
                  throw new Error("A recovered sidecar operation has an unknown terminal and cannot be safely re-executed.");
                }
                const terminal = readResolvedTerminal(resolution, this.options.input);
                await this.options.operationLedger?.terminal({
                  ...recovered.unknown,
                  outcome: resolution.outcome,
                  result: terminal.result,
                  messages: resolution.messages,
                  ...(resolution.seedState ? { seedState: resolution.seedState } : {}),
                });
                terminalObserved = true;
                yield {
                  type: "turn_completed",
                  sessionId: this.options.input.sessionId,
                  turnId: this.options.input.turnId,
                  result: terminal.result,
                };
                return terminal;
              }
              if (recovered?.state === "incomplete") {
                throw new Error("A recovered sidecar operation is incomplete and cannot be safely re-executed.");
              }
              await this.options.operationLedger?.start(this.operationIdentity());
              await this.send(this.executeRequest());
              executeStarted = true;
            }
            continue;
          }
          if (phase === "resume") {
            this.acceptResumeResponse(message);
            phase = "execute";
            continue;
          }
          const terminal = await this.acceptResponse(message);
          if (terminal) {
            const hostTerminal = await this.recordKnownTerminal(this.withHostToolCheckpoint(terminal), "failed");
            terminalObserved = true;
            yield {
              type: "turn_completed",
              sessionId: this.options.input.sessionId,
              turnId: this.options.input.turnId,
              result: hostTerminal.result,
            };
            return hostTerminal;
          }
          continue;
        }
        if (message.kind === "error") {
          throw new Error(`Sidecar transport error ${message.code}: ${message.message}`);
        }
        if (message.kind !== "event") continue;
        if (phase !== "execute") throw new Error("Sidecar emitted an event before handshake completed.");
        this.assertEventIdentity(message);
        if (message.final) {
          let terminal = message.outcome === "result_unknown"
            ? await this.reconcileResultUnknown(message)
            : this.withHostToolCheckpoint(readFinalTerminal(message, this.options.input));
          if (isResolvedModuleOutcome(message.outcome)) {
            terminal = await this.recordKnownTerminal(terminal, message.outcome);
          }
          terminalObserved = true;
          // Module final is the authoritative terminal. Suppress a preceding
          // sidecar turn_completed event and publish exactly this validated one.
          yield {
            type: "turn_completed",
            sessionId: this.options.input.sessionId,
            turnId: this.options.input.turnId,
            result: terminal.result,
          };
          return terminal;
        }
        const event = readAgentEvent(message, this.options.input);
        if (event.type !== "turn_completed") {
          yield event;
          this.sendAckIfReady();
        }
      }
    } catch (error) {
      this.observeReconnectFailure();
      if (isAgentLoopResultUnknownError(error)) {
        this.observe({
          type: "result_unknown_fail_closed",
          source: this.resultUnknownSource ?? "transport_interruption",
        });
        throw error;
      }
      if (executeStarted && !terminalObserved && this.streamId) {
        try {
          const terminal = await this.reconcileTransportInterruption(
            error,
            this.resultUnknownSource ?? "transport_interruption",
          );
          terminalObserved = true;
          yield {
            type: "turn_completed",
            sessionId: this.options.input.sessionId,
            turnId: this.options.input.turnId,
            result: terminal.result,
          };
          return terminal;
        } catch {
          // Preserve the original transport error. A failed status query or
          // durable write must not be mistaken for a business terminal.
          this.observe({
            type: "result_unknown_fail_closed",
            source: this.resultUnknownSource ?? "transport_interruption",
          });
        }
      }
      throw error;
    } finally {
      removeAbortListener();
    }
  }

  private handshakeRequest(method: "hello" | "capabilities"): ModuleHandshakeRequest {
    const initial = this.reconnectAttempts === 0;
    const messageId = initial
      ? method === "hello" ? this.helloMessageId : this.capabilitiesMessageId
      : `${method}-${this.options.uuid()}`;
    if (!initial) {
      if (method === "hello") this.helloMessageId = messageId;
      else this.capabilitiesMessageId = messageId;
    }
    return {
      kind: "request",
      messageId,
      method,
      payload: {},
    };
  }

  private executeRequest(): ModuleExecuteRequest {
    const { config, input } = this.options;
    const seedState = this.hostToolCheckpoint.snapshot();
    return {
      kind: "request",
      messageId: this.executeMessageId,
      method: "execute",
      runId: this.runId,
      operationId: this.operationId,
      requestId: this.requestId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.execution?.idempotencyKey ? { idempotencyKey: input.execution.idempotencyKey } : {}),
      ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}),
      payload: {
        agent: serializeAgentConfig(config),
        messages: input.messages,
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
        ...(input.taskBudgetUsd !== undefined ? { taskBudgetUsd: input.taskBudgetUsd } : {}),
        ...(input.initialTaskBudgetSpentUsd !== undefined
          ? { initialTaskBudgetSpentUsd: input.initialTaskBudgetSpentUsd }
          : {}),
        ...(input.canElicit !== undefined ? { canElicit: input.canElicit } : {}),
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.basePermissionMode !== undefined ? { basePermissionMode: input.basePermissionMode } : {}),
        ...(input.allowPlanModeTools !== undefined ? { allowPlanModeTools: input.allowPlanModeTools } : {}),
        tools: this.manifest.tools,
        permissionContext: this.manifest.permissionContext,
        hostModules: this.manifest.hostModules,
        interactionCapabilities: this.manifest.interactionCapabilities,
        ...(seedState ? { seedState: serializeAgentLoopSeedStateProjection(seedState) } : {}),
        ...(this.options.modelState
          ? { modelState: serializeAgentLoopModelSessionStateProjection(this.options.modelState) }
          : {}),
      },
    };
  }

  private async acceptResponse(message: ModuleResponse): Promise<SidecarTerminal | undefined> {
    if (message.inReplyTo !== this.executeMessageId) return;
    if (message.requestId !== this.requestId) {
      throw new Error("Sidecar execute response does not match the active request.");
    }
    if (!message.ok) {
      if (message.final === true && message.outcome === "failed") {
        return rejectedExecuteTerminal(message, this.options.input);
      }
      throw new Error(`Sidecar rejected execute request: ${message.code ?? message.error?.message ?? "unknown error"}`);
    }
    if (message.final === true) {
      throw new Error("Sidecar streaming execute response cannot be final when accepted.");
    }
    if (!message.streamId) throw new Error("Sidecar execute response did not provide streamId.");
    this.streamId = message.streamId;
    await this.options.operationLedger?.accept(this.acceptedOperation());
    this.observe({ type: "stream_accepted", resumeSupported: this.supportsResume });
    this.sendCancelIfReady();
  }

  private acceptHandshakeResponse(message: ModuleResponse, phase: "hello" | "capabilities"): void {
    const expectedId = phase === "hello" ? this.helloMessageId : this.capabilitiesMessageId;
    if (message.inReplyTo !== expectedId) {
      throw new Error(`Sidecar ${phase} response does not match the active handshake request.`);
    }
    if (!message.ok) {
      throw new Error(`Sidecar rejected ${phase}: ${message.code ?? message.error?.message ?? "unknown error"}`);
    }
    const binding = parseBinding(message);
    if (phase === "hello") {
      if (this.options.expectedModuleId && binding.moduleId !== this.options.expectedModuleId) {
        throw new Error(`Sidecar module identity '${binding.moduleId}' does not match configured implementation '${this.options.expectedModuleId}'.`);
      }
      if (this.binding) {
        if (this.binding.moduleId !== binding.moduleId) {
          throw new Error("Sidecar changed its module identity while resuming a stream.");
        }
        if (this.binding.moduleInstanceId !== binding.moduleInstanceId) {
          this.observe({ type: "sidecar_instance_restarted" });
          throw new SidecarInstanceRestartedError();
        }
      } else {
        this.binding = binding;
      }
      this.connectionBinding = binding;
      return;
    }
    if (!this.connectionBinding || !sameBinding(this.connectionBinding, binding)) {
      throw new Error("Sidecar changed its binding during handshake.");
    }
    const capabilities = parseCapabilities(message, binding.capabilitiesVersion);
    const execute = capabilities.methods.find((method) => method.name === "execute");
    if (!execute || execute.enabled === false || !execute.profiles?.includes("streaming")) {
      throw new Error("Sidecar does not advertise a streaming execute capability.");
    }
    this.supportsCancel = capabilities.methods.some((method) => method.name === "cancel" && method.enabled !== false)
      || execute.cancel === true;
    this.supportsResume = execute.resumeSupport === "streaming"
      && capabilities.methods.some((method) => method.name === "resume" && method.enabled !== false)
      && capabilities.methods.some((method) => method.name === "ack" && method.enabled !== false);
    this.observe({
      type: "handshake_completed",
      moduleId: binding.moduleId,
      capabilitiesVersion: binding.capabilitiesVersion,
    });
  }

  private resumeRequest(): Extract<ModuleMessage, { kind: "request"; method: "resume" }> {
    if (!this.streamId || !this.pendingResumeBinding) {
      throw new Error("Sidecar reconnect has no accepted stream binding.");
    }
    this.resumeMessageId = `resume-${this.options.uuid()}`;
    return {
      kind: "request",
      messageId: this.resumeMessageId,
      method: "resume",
      streamId: this.streamId,
      previousBinding: this.pendingResumeBinding,
      lastAppliedSequence: this.nextSequence - 1,
    };
  }

  private acceptResumeResponse(message: ModuleResponse): void {
    if (!this.resumeMessageId || message.inReplyTo !== this.resumeMessageId) {
      throw new Error("Sidecar resume response does not match the active resume request.");
    }
    if (!message.ok) {
      throw new Error(`Sidecar resume failed: ${message.code ?? message.error?.message ?? "unknown error"}`);
    }
    if (message.streamId !== undefined && message.streamId !== this.streamId) {
      throw new Error("Sidecar resume response changed the stream identity.");
    }
    this.pendingResumeBinding = undefined;
    this.resumeMessageId = undefined;
    this.reconnectSucceeded = true;
    this.observe({ type: "reconnect_succeeded", attempt: this.reconnectAttempts });
  }

  private assertEventIdentity(event: ModuleEvent): void {
    if (!this.streamId) throw new Error("Sidecar emitted an event before accepting execute.");
    if (
      event.streamId !== this.streamId
      || event.runId !== this.runId
      || event.operationId !== this.operationId
      || event.requestId !== this.requestId
    ) {
      throw new Error("Sidecar event identity does not match the active execution.");
    }
    if (event.sequence !== this.nextSequence) {
      throw new Error(`Sidecar event sequence mismatch: expected ${this.nextSequence}, got ${event.sequence}.`);
    }
    this.nextSequence += 1;
  }

  private async reconnect(): Promise<AgentLoopSidecarConnection | undefined> {
    const connection = this.connection;
    const previousBinding = this.connectionBinding;
    if (
      !connection?.reconnect
      || !this.streamId
      || !previousBinding
      || !this.supportsResume
      || this.reconnectAttempts >= 1
    ) return undefined;
    this.reconnectAttempts += 1;
    const lastAppliedSequence = this.nextSequence - 1;
    this.observe({ type: "reconnect_started", attempt: this.reconnectAttempts, lastAppliedSequence });
    let replacement: AgentLoopSidecarConnection;
    try {
      replacement = await connection.reconnect({
        streamId: this.streamId,
        previousBinding: {
          moduleInstanceId: previousBinding.moduleInstanceId,
          connectionGeneration: previousBinding.connectionGeneration,
        },
        lastAppliedSequence,
      });
    } catch (error) {
      this.observeReconnectFailure();
      throw error;
    }
    this.pendingResumeBinding = {
      moduleInstanceId: previousBinding.moduleInstanceId,
      connectionGeneration: previousBinding.connectionGeneration,
    };
    this.connection = replacement;
    this.connectionBinding = undefined;
    return replacement;
  }

  private linkCancellation(): () => void {
    const signal = this.options.input.abortSignal;
    if (!signal) return () => undefined;
    const requestCancel = () => {
      this.cancelRequested = true;
      this.sendCancelIfReady();
    };
    if (signal.aborted) requestCancel();
    else signal.addEventListener("abort", requestCancel, { once: true });
    return () => signal.removeEventListener("abort", requestCancel);
  }

  private sendCancelIfReady(): void {
    if (!this.cancelRequested || this.cancelSent || !this.streamId || !this.supportsCancel) return;
    this.cancelSent = true;
    const signalReason = this.options.input.abortSignal?.reason;
    const reason = typeof signalReason === "string" && signalReason.length > 0
      ? signalReason
      : "host_abort";
    void Promise.resolve(this.send({
      kind: "request",
      messageId: `cancel-${this.options.uuid()}`,
      method: "cancel",
      runId: this.runId,
      operationId: this.operationId,
      requestId: this.requestId,
      reason,
    })).catch(() => undefined);
  }

  private sendAckIfReady(): void {
    if (!this.supportsResume || !this.streamId || this.nextSequence <= 0) return;
    void Promise.resolve(this.send({
      kind: "request",
      messageId: `ack-${this.options.uuid()}`,
      method: "ack",
      streamId: this.streamId,
      lastAppliedSequence: this.nextSequence - 1,
    })).catch(() => undefined);
  }

  private send(message: ModuleMessage): void | Promise<void> {
    if (!this.connection) throw new Error("Sidecar transport connection is unavailable.");
    return this.connection.send(message);
  }

  async close(reason?: unknown): Promise<void> {
    await this.connection?.close?.(reason);
  }

  private async reconcileResultUnknown(event: ModuleEvent): Promise<SidecarTerminal> {
    if (!this.streamId || !this.binding) {
      throw new Error("Sidecar terminal outcome is result_unknown; host reconciliation is required.");
    }
    const unknown: AgentLoopOperationUnknownTerminal = {
      ...this.acceptedOperation(),
      lastAppliedSequence: this.nextSequence - 1,
      ...(event.code ? { code: event.code } : {}),
      ...(event.error === undefined ? {} : { error: event.error }),
    };
    this.resultUnknownSource = "sidecar_final";
    return this.reconcileUnknownTerminal(unknown, this.resultUnknownSource);
  }

  /**
   * A dead connection or a new instance cannot prove an AgentLoop terminal.
   * Record that fact first, then let the host's durable ledger or side-effect
   * status provider decide whether a terminal is safe to publish.
   */
  private async reconcileTransportInterruption(
    error: unknown,
    source: "sidecar_final" | "transport_interruption" = "transport_interruption",
  ): Promise<SidecarTerminal> {
    if (!this.streamId || !this.binding) {
      throw new Error("Sidecar transport interrupted before an accepted stream could be reconciled.");
    }
    return this.reconcileUnknownTerminal({
      ...this.acceptedOperation(),
      lastAppliedSequence: this.nextSequence - 1,
      code: error instanceof SidecarInstanceRestartedError
        ? "SIDECAR_INSTANCE_RESTARTED"
        : "TRANSPORT_INTERRUPTED",
      error: serializeTransportError(error),
    }, source);
  }

  private async reconcileUnknownTerminal(
    unknown: AgentLoopOperationUnknownTerminal,
    source: "sidecar_final" | "transport_interruption",
  ): Promise<SidecarTerminal> {
    await this.options.operationLedger?.resultUnknown(unknown);
    const ledgerResolution = await this.options.operationLedger?.reconcile(unknown);
    const resolution = ledgerResolution ?? await this.options.reconcileResultUnknown?.(unknown);
    if (!resolution) {
      throw new AgentLoopResultUnknownError();
    }
    const terminal = readResolvedTerminal(resolution, this.options.input);
    // A successful external status query becomes the new durable source of
    // truth. Without this write, a later session recovery would see only the
    // result_unknown observation and repeat reconciliation indefinitely.
    const projected = await this.recordKnownTerminal(terminal, resolution.outcome);
    this.observe({ type: "result_unknown_resolved", source, outcome: resolution.outcome });
    return projected;
  }

  private withHostToolCheckpoint(terminal: SidecarTerminal): SidecarTerminal {
    return { ...terminal, seedState: this.hostToolCheckpoint.snapshot() };
  }

  private operationIdentity(): AgentLoopOperationIdentity {
    if (!this.binding) throw new Error("Sidecar execute started without a handshake binding.");
    return {
      runId: this.runId,
      operationId: this.operationId,
      requestId: this.requestId,
      sessionId: this.options.input.sessionId,
      turnId: this.options.input.turnId,
      binding: {
        moduleInstanceId: this.binding.moduleInstanceId,
        connectionGeneration: this.binding.connectionGeneration,
      },
      ...(this.options.input.execution?.idempotencyKey
        ? { idempotencyKey: this.options.input.execution.idempotencyKey }
        : {}),
    };
  }

  private acceptedOperation(): AgentLoopOperationAccepted {
    if (!this.streamId) throw new Error("Sidecar operation has no accepted stream identity.");
    return { ...this.operationIdentity(), streamId: this.streamId };
  }

  private async recordKnownTerminal(
    terminal: SidecarTerminal,
    outcome: Exclude<ModuleOutcome, "result_unknown">,
  ): Promise<SidecarTerminal> {
    const projected = this.options.projectTerminal?.(terminal) ?? terminal;
    await this.options.operationLedger?.terminal({
      ...this.operationIdentity(),
      ...(this.streamId ? { streamId: this.streamId } : {}),
      lastAppliedSequence: this.nextSequence - 1,
      outcome,
      result: projected.result,
      messages: projected.messages,
      ...(projected.seedState ? { seedState: projected.seedState } : {}),
    });
    return projected;
  }

  private async dispatchModuleCall(call: ModuleCallRequest): Promise<ModuleResponse> {
    try {
      this.assertModuleCallIdentity(call);
      this.observe({
        type: "module_call_received",
        module: call.module,
        ...(typeof call.payload.operation === "string" ? { operation: call.payload.operation } : {}),
      });
      const payload = await this.dispatchModule(call);
      return moduleResponse(call, this.options.uuid, true, payload);
    } catch (error) {
      return moduleResponse(call, this.options.uuid, false, undefined, error);
    }
  }

  /**
   * A host module may have completed a permission or a non-idempotent tool
   * operation just as its response loses the socket. Reconnect first and wait
   * for the server to replay the immutable request; never dispatch it twice.
   */
  private async sendModuleResponse(call: ModuleCallRequest): Promise<AgentLoopSidecarConnection | undefined> {
    const { response, replayed } = await this.moduleResponseFor(call);
    try {
      await this.send(response);
      if (replayed) {
        this.observe({ type: "cached_module_response_replayed", module: call.module });
      }
      return undefined;
    } catch (error) {
      const replacement = await this.reconnect();
      if (!replacement) throw error;
      return replacement;
    }
  }

  private async moduleResponseFor(call: ModuleCallRequest): Promise<{
    response: ModuleResponse;
    replayed: boolean;
  }> {
    const cached = this.completedModuleResponses.get(call.messageId);
    if (cached) {
      this.assertModuleCallIdentity(call);
      if (!sameModuleCall(cached.call, call)) {
        throw new Error("Sidecar replayed a module_call with a conflicting immutable identity.");
      }
      this.observe({ type: "pending_module_call_replayed", module: call.module });
      return { response: cached.response, replayed: true };
    }
    const response = await this.dispatchModuleCall(call);
    // Cache before delivery: a failed response write must never repeat the
    // permission/tool operation when this live sidecar stream resumes.
    this.completedModuleResponses.set(call.messageId, { call, response });
    return { response, replayed: false };
  }

  private observe(observation: AgentLoopSidecarTransportObservation): void {
    try {
      void Promise.resolve(this.options.transportObserver?.observe(observation)).catch(() => undefined);
    } catch {
      // Deployment telemetry is not part of the AgentLoop or host terminal.
    }
  }

  private observeReconnectFailure(): void {
    if (this.reconnectAttempts === 0 || this.reconnectSucceeded || this.reconnectFailureObserved) return;
    this.reconnectFailureObserved = true;
    this.observe({ type: "reconnect_failed", attempt: this.reconnectAttempts });
  }

  private assertModuleCallIdentity(call: ModuleCallRequest): void {
    if (call.runId !== this.runId || call.operationId !== this.operationId) {
      throw new Error("Sidecar module call identity does not match the active execution.");
    }
  }

  private async dispatchModule(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    const handler = this.handlers[call.module as keyof SidecarModuleHandlers];
    if (!handler) throw new Error(`Unsupported sidecar host module: ${call.module}`);
    return handler(call);
  }

}

function isModuleCall(message: ModuleMessage): message is ModuleCallRequest {
  return message.kind === "request" && message.method === "module_call";
}

/** Replayed module calls must be byte-for-byte equivalent protocol facts. */
function sameModuleCall(left: ModuleCallRequest, right: ModuleCallRequest): boolean {
  return left.messageId === right.messageId
    && left.runId === right.runId
    && left.operationId === right.operationId
    && left.requestId === right.requestId
    && left.idempotencyKey === right.idempotencyKey
    && left.module === right.module
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

function parseBinding(message: ModuleResponse): SidecarBinding {
  if (message.protocolVersion !== MODULE_PROTOCOL_VERSION) {
    throw new Error(`Sidecar protocol version is unsupported: ${message.protocolVersion ?? "missing"}.`);
  }
  const moduleId = nonEmptyResponseField(message.moduleId, "moduleId");
  const moduleInstanceId = nonEmptyResponseField(message.moduleInstanceId, "moduleInstanceId");
  const connectionGeneration = nonEmptyResponseField(message.connectionGeneration, "connectionGeneration");
  const capabilitiesVersion = nonEmptyResponseField(message.capabilitiesVersion, "capabilitiesVersion");
  return { moduleId, moduleInstanceId, connectionGeneration, capabilitiesVersion };
}

function parseCapabilities(message: ModuleResponse, expectedVersion: string): ModuleCapabilities {
  const payload = asRecord(message.payload);
  if (!payload || payload.capabilitiesVersion !== expectedVersion || !Array.isArray(payload.methods)) {
    throw new Error("Sidecar capabilities response does not match its hello binding.");
  }
  for (const method of payload.methods) {
    const entry = asRecord(method);
    if (!entry || !isCapabilityMethodName(entry.name)) {
      throw new Error("Sidecar capabilities response contains an invalid method.");
    }
  }
  return payload as unknown as ModuleCapabilities;
}

function sameBinding(left: SidecarBinding, right: SidecarBinding): boolean {
  return left.moduleId === right.moduleId
    && left.moduleInstanceId === right.moduleInstanceId
    && left.connectionGeneration === right.connectionGeneration
    && left.capabilitiesVersion === right.capabilitiesVersion;
}

function nonEmptyResponseField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Sidecar handshake response is missing ${name}.`);
  }
  return value;
}

function isCapabilityMethodName(value: unknown): value is ModuleCapabilities["methods"][number]["name"] {
  return value === "execute" || value === "cancel" || value === "status" || value === "resume" || value === "ack";
}

function moduleResponse(
  call: ModuleCallRequest,
  uuid: () => string,
  ok: boolean,
  payload?: Record<string, unknown>,
  error?: unknown,
): ModuleResponse {
  if (ok) {
    return {
      kind: "response",
      messageId: `host-module-${uuid()}`,
      inReplyTo: call.messageId,
      requestId: call.requestId,
      ok: true,
      ...(payload ? { payload } : {}),
    };
  }
  return {
    kind: "response",
    messageId: `host-module-${uuid()}`,
    inReplyTo: call.messageId,
    requestId: call.requestId,
    ok: false,
    code: errorCode(error) ?? "HOST_MODULE_FAILED",
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(canonicalModelError(error) ? { canonical: canonicalModelError(error) } : {}),
      ...(errorBoolean(error, "retryable") !== undefined ? { retryable: errorBoolean(error, "retryable") } : {}),
      ...(errorNumber(error, "retryAfterMs") !== undefined ? { retryAfterMs: errorNumber(error, "retryAfterMs") } : {}),
    },
  };
}

function canonicalModelError(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { error?: unknown }).error;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string"
    ? record
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function errorBoolean(error: unknown, field: string): boolean | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : undefined;
}

function errorNumber(error: unknown, field: string): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function serializeAgentConfig(config: AgentRuntimeConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    cwd: config.cwd,
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.appendSystemPrompt ? { appendSystemPrompt: config.appendSystemPrompt } : {}),
    ...(config.planModeInstructions ? { planModeInstructions: config.planModeInstructions } : {}),
    ...(config.runtimeContextSurface ? { runtimeContextSurface: config.runtimeContextSurface } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.maxContextTokens ? { maxContextTokens: config.maxContextTokens } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    ...(config.toolChoice ? { toolChoice: config.toolChoice } : {}),
    ...(config.maxContextMessages !== undefined ? { maxContextMessages: config.maxContextMessages } : {}),
    ...(config.stopOnStructuredOutput !== undefined
      ? { stopOnStructuredOutput: config.stopOnStructuredOutput }
      : {}),
    ...(config.jsonSelfCorrect !== undefined ? { jsonSelfCorrect: config.jsonSelfCorrect } : {}),
    ...(config.runMode ? { runMode: config.runMode } : {}),
    ...(config.permissionModeBeforePlan
      ? { permissionModeBeforePlan: config.permissionModeBeforePlan }
      : {}),
    ...(config.isSubagent !== undefined ? { isSubagent: config.isSubagent } : {}),
    ...(config.metadata ? { metadata: config.metadata } : {}),
    ...(config.subagentModel ? { subagentModel: config.subagentModel } : {}),
  };
}

function readAgentEvent(event: ModuleEvent, input: AgentLoopInput): AgentEvent {
  const value = asRecord(event.payload);
  if (!value || typeof value.type !== "string") throw new Error("Sidecar event payload is not an AgentEvent.");
  if (value.sessionId !== input.sessionId || ("turnId" in value && value.turnId !== input.turnId)) {
    throw new Error("Sidecar AgentEvent does not match the active session or turn.");
  }
  return value as unknown as AgentEvent;
}


function readTerminal(event: ModuleEvent, input: AgentLoopInput): SidecarTerminal {
  const payload = asRecord(event.payload);
  const result = payload?.result;
  const messages = payload?.messages;
  if (!isAgentTurnResult(result) || !Array.isArray(messages)) {
    throw new Error("Sidecar terminal payload does not contain an AgentLoop result.");
  }
  assertTerminalResult(event.outcome, result, input);
  return {
    result,
    messages: messages as CanonicalMessage[],
    ...(payload?.seedState === undefined ? {} : { seedState: parseAgentLoopSeedStateProjection(payload.seedState) }),
    ...(payload?.modelState === undefined
      ? {}
      : { modelState: parseAgentLoopModelSessionStateProjection(payload.modelState) }),
  };
}

function readFinalTerminal(event: ModuleEvent, input: AgentLoopInput): SidecarTerminal {
  const payload = asRecord(event.payload);
  if (isAgentTurnResult(payload?.result) && Array.isArray(payload?.messages)) {
    return readTerminal(event, input);
  }
  if (
    event.outcome === "cancelled"
    && input.abortSignal?.aborted
    && input.abortSignal.reason === "compaction_persistence_failed"
  ) {
    return abortedResult(input);
  }
  return readTerminal(event, input);
}

/**
 * A deadline can expire before a streaming execute is accepted, so the
 * protocol has no stream identity or final event to project. Preserve its
 * protocol failure as one host-visible AgentLoop terminal instead of treating
 * a valid final response as a malformed connection error.
 */
function rejectedExecuteTerminal(message: ModuleResponse, input: AgentLoopInput): SidecarTerminal {
  const error = asRecord(message.error);
  const code = message.code ?? (typeof error?.code === "string" ? error.code : undefined);
  const failureMessage = typeof error?.message === "string"
    ? error.message
    : code
      ? `Sidecar rejected execute request: ${code}`
      : "Sidecar rejected execute request.";
  const now = new Date().toISOString();
  return {
    result: {
      type: "error",
      sessionId: input.sessionId,
      turnId: input.turnId,
      // Native execution aborts the active model stream at the same deadline.
      // Preserve that terminal classification even when the sidecar rejects
      // before an execute stream can be accepted.
      stopReason: code === "DEADLINE_EXCEEDED" ? "aborted_streaming" : "model_error",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: now,
      completedAt: now,
      errors: [agentError("agent_execution_rejected", failureMessage, {
        ...(code ? { sidecarCode: code } : {}),
        ...(message.error === undefined ? {} : { sidecarError: message.error }),
      })],
    },
    messages: input.messages,
  };
}

function readResolvedTerminal(
  resolution: AgentLoopSidecarResultUnknownResolution,
  input: AgentLoopInput,
): SidecarTerminal {
  if (!Array.isArray(resolution.messages)) {
    throw new Error("Host result_unknown reconciliation did not return canonical messages.");
  }
  assertTerminalResult(resolution.outcome, resolution.result, input);
  return {
    result: resolution.result,
    messages: resolution.messages,
    ...(resolution.seedState === undefined ? {} : { seedState: cloneSeedState(resolution.seedState) }),
  };
}

function assertTerminalResult(
  outcome: ModuleOutcome | undefined,
  result: AgentTurnResult,
  input: AgentLoopInput,
): void {
  if (result.sessionId !== input.sessionId || result.turnId !== input.turnId) {
    throw new Error("Sidecar terminal result does not match the active session or turn.");
  }
  if (outcome === "completed" && result.type !== "success") {
    throw new Error("Completed sidecar terminal does not contain a successful result.");
  }
  if (outcome === "cancelled" && result.type !== "aborted") {
    throw new Error("Cancelled sidecar terminal does not contain an aborted result.");
  }
  if (outcome === "failed" && result.type !== "error" && result.type !== "max_turns") {
    throw new Error("Failed sidecar terminal does not contain a failed result.");
  }
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") {
    throw new Error("Sidecar terminal outcome is invalid for a resolved execute result.");
  }
}

function isResolvedModuleOutcome(
  outcome: ModuleOutcome | undefined,
): outcome is Exclude<ModuleOutcome, "result_unknown"> {
  return outcome === "completed" || outcome === "failed" || outcome === "cancelled";
}

function abortedResult(input: AgentLoopInput): AgentLoopRunResult {
  const now = new Date().toISOString();
  return {
    result: {
      type: "aborted",
      sessionId: input.sessionId,
      turnId: input.turnId,
      stopReason: "aborted_streaming",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: now,
      completedAt: now,
    },
    messages: input.messages,
  };
}

function isAgentTurnResult(value: unknown): value is AgentTurnResult {
  const result = asRecord(value);
  return Boolean(
    result
      && (result.type === "success" || result.type === "error" || result.type === "aborted" || result.type === "max_turns")
      && typeof result.sessionId === "string"
      && typeof result.turnId === "string"
      && typeof result.stopReason === "string"
      && typeof result.turns === "number",
  );
}

function cloneSeedState(seedState: AgentLoopSeedState | undefined): AgentLoopSeedState | undefined {
  return seedState ? parseAgentLoopSeedStateProjection(serializeAgentLoopSeedStateProjection(seedState)) : undefined;
}

function sidecarTransportTurn(input: AgentLoopInput): SidecarTransportTurn {
  return Object.freeze({
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.execution?.runId ?? `run-${input.turnId}`,
    operationId: input.execution?.operationId ?? input.turnId,
    ...(input.execution?.idempotencyKey ? { idempotencyKey: input.execution.idempotencyKey } : {}),
    ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}),
  });
}

type ActiveHostSubagent = {
  subagentId: string;
  subagentType?: string;
  startedAtMs: number;
  lastHeartbeatMs: number;
  currentToolCallId?: string;
  currentToolName?: string;
};

/**
 * The runner owns the externally visible timeline for both child and host
 * events. Child-local coordinates are transport implementation details and
 * must not form a second visible allocator chain.
 */
class SidecarHostEventProjector {
  private readonly timeline: TurnTimeline;
  private readonly activeSubagents = new Map<string, ActiveHostSubagent>();

  constructor(
    private readonly input: AgentLoopInput,
    private readonly moduleId: () => string | undefined,
  ) {
    this.timeline = new TurnTimeline(input.turnId);
  }

  drain(events: readonly AgentEvent[]): AgentEvent[] {
    const projected: AgentEvent[] = [];
    for (const event of events) {
      const timed = this.project(event);
      projected.push(timed);
      const status = this.deriveSubagentStatus(event);
      if (status) projected.push(this.project(status));
    }
    return projected;
  }

  project(event: AgentEvent): AgentEvent {
    if (event.type === "subagent_model_event") {
      // A subagent has its own stream allocator. It is not a child-sidecar
      // coordinate and must remain intact for the Gateway subagent stream.
      return event;
    }
    const { timeline: _timeline, streamBoundary: _streamBoundary, ...untimed } = stripChildTimeline(event);
    const moduleId = this.moduleId();
    const owned = moduleId ? markModuleOwnedEvent(untimed as AgentEvent, moduleId) : untimed;
    return this.timeline.event({
      ...owned,
      ...(moduleId ? { moduleId } : {}),
    } as AgentEvent);
  }

  projectTerminal(terminal: SidecarTerminal): SidecarTerminal {
    const messages = terminal.messages.map((message) => this.projectTerminalMessage(message));
    const finalMessage = terminal.result.finalMessage
      ? this.projectTerminalMessage(terminal.result.finalMessage)
      : undefined;
    return {
      ...terminal,
      messages,
      result: {
        ...terminal.result,
        ...(finalMessage ? { finalMessage } : {}),
      },
    };
  }

  private projectTerminalMessage(message: CanonicalMessage): CanonicalMessage {
    const projected = stripMessageTimeline(message);
    const moduleId = this.moduleId();
    if (moduleId && isModuleOwnedTerminalMessage(projected)) {
      projected.metadata = { ...projected.metadata, moduleId };
    }
    for (const block of projected.content) {
      const id = timelineContentId(block);
      if (id) block.timeline = this.timeline.position(id);
      else if (projected.metadata?.queueItemId) block.timeline = this.timeline.position(`steer:${projected.metadata.queueItemId}`);
    }
    return projected;
  }

  heartbeats(nowMs = Date.now()): AgentEvent[] {
    const result: AgentEvent[] = [];
    for (const state of this.activeSubagents.values()) {
      if (nowMs - state.lastHeartbeatMs < 2_000) continue;
      state.lastHeartbeatMs = nowMs;
      result.push(this.timeline.event({
        type: "subagent_status",
        sessionId: this.input.sessionId,
        turnId: this.input.turnId,
        subagentId: state.subagentId,
        subagentType: state.subagentType,
        status: state.currentToolName ? "running" : "waiting_model",
        toolCallId: state.currentToolCallId,
        toolName: state.currentToolName,
        durationMs: Math.max(0, nowMs - state.startedAtMs),
      }));
    }
    return result;
  }

  private deriveSubagentStatus(event: AgentEvent): AgentEvent | undefined {
    const nowMs = Date.now();
    if (event.type === "subagent_started") {
      this.activeSubagents.set(event.subagentId, {
        subagentId: event.subagentId,
        subagentType: event.subagentType,
        startedAtMs: nowMs,
        lastHeartbeatMs: nowMs,
      });
      return undefined;
    }
    if (event.type === "subagent_completed") {
      this.activeSubagents.delete(event.subagentId);
      return undefined;
    }
    if (event.type !== "pre_tool_execute" && event.type !== "post_tool_execute") return undefined;
    const subagentId = subagentIdFromSessionId(event.sessionId);
    if (!subagentId) return undefined;
    const state = this.activeSubagents.get(subagentId) ?? {
      subagentId,
      startedAtMs: nowMs,
      lastHeartbeatMs: nowMs,
    };
    if (event.type === "pre_tool_execute") {
      state.currentToolCallId = event.toolCallId;
      state.currentToolName = event.toolName;
    } else {
      state.currentToolCallId = undefined;
      state.currentToolName = undefined;
    }
    state.lastHeartbeatMs = nowMs;
    this.activeSubagents.set(subagentId, state);
    return {
      type: "subagent_status",
      sessionId: this.input.sessionId,
      turnId: this.input.turnId,
      subagentId,
      subagentType: state.subagentType,
      status: event.type === "pre_tool_execute" ? "tool_started" : "tool_completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "post_tool_execute" ? { success: event.success } : {}),
      durationMs: Math.max(0, nowMs - state.startedAtMs),
    };
  }
}

/**
 * A sidecar child may retain its own transient stream coordinates. They are
 * not valid outside that child: the runner's timeline is the sole allocator
 * for host-visible events and the message blocks embedded in those events.
 */
function stripChildTimeline(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "assistant_message":
    case "tool_results_projected":
    case "steer_applied":
      return { ...event, message: stripMessageTimeline(event.message) };
    case "tool_calls_detected":
      return {
        ...event,
        calls: event.calls.map((call): CanonicalToolCall => {
          const { timeline: _timeline, ...untimed } = call;
          return untimed;
        }),
      };
    case "model_event":
    case "subagent_model_event":
      if (event.event.type !== "tool_call_end") return event;
      return {
        ...event,
        event: {
          ...event.event,
          toolCall: (() => {
            const { timeline: _timeline, ...untimed } = event.event.toolCall;
            return untimed;
          })(),
        },
      };
    default:
      return event;
  }
}

function stripMessageTimeline(message: CanonicalMessage): CanonicalMessage {
  return { ...message, content: message.content.map(stripCanonicalContentTimeline) };
}

function isModuleOwnedTerminalMessage(message: CanonicalMessage): boolean {
  return message.role === "assistant" || message.content.some((block) => block.type === "tool_result");
}

function markModuleOwnedEvent(event: AgentEvent, moduleId: string): AgentEvent {
  if ((event.type === "assistant_message" || event.type === "tool_results_projected")
    && isModuleOwnedTerminalMessage(event.message)) {
    return {
      ...event,
      message: { ...event.message, metadata: { ...event.message.metadata, moduleId } },
    };
  }
  return event;
}

function timelineContentId(block: CanonicalContentBlock): string | undefined {
  if (block.type === "text" || block.type === "thinking") return block.blockId;
  if (block.type === "tool_call") return `tool:${block.id}`;
  if (block.type === "tool_result" || block.type === "tool_result_reference") return `result:${block.toolCallId}`;
  return undefined;
}

function stripCanonicalContentTimeline(block: CanonicalContentBlock): CanonicalContentBlock {
  if (block.type === "tool_result") {
    const { timeline: _timeline, ...untimed } = block;
    return {
      ...untimed,
      content: block.content.map(stripToolResultContentTimeline),
    } as CanonicalContentBlock;
  }
  const { timeline: _timeline, ...untimed } = block;
  return untimed as CanonicalContentBlock;
}

function stripToolResultContentTimeline<T extends object>(content: T): T {
  if (!("timeline" in content)) return { ...content };
  const { timeline: _timeline, ...untimed } = content as T & { timeline?: unknown };
  return untimed as T;
}

function subagentIdFromSessionId(sessionId: string): string | undefined {
  const marker = "::sub::";
  const index = sessionId.lastIndexOf(marker);
  if (index < 0) return undefined;
  const subagentId = sessionId.slice(index + marker.length).trim();
  return subagentId.length > 0 ? subagentId : undefined;
}

function modelOverride(value: unknown): { provider: string; model: string } | undefined {
  const record = asRecord(value);
  return record && typeof record.provider === "string" && typeof record.model === "string"
    ? { provider: record.provider, model: record.model }
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, field: string): string {
  const candidate = value?.[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Sidecar payload field ${field} must be a non-empty string.`);
  }
  return candidate;
}

function optionalStringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw new Error(`Sidecar payload field ${field} must be a string when provided.`);
  }
  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sidecarStatusMessage(event: Extract<AgentEvent, { type: "agent_status" }>): {
  event: string;
  kind: "status" | "error";
  text: string;
  detail?: Record<string, unknown>;
} {
  const detail = event.detail ?? {};
  return {
    event: event.event,
    kind: event.kind ?? (isFailureStatusEvent(event.event, detail) ? "error" : "status"),
    text: event.text ?? (typeof detail.message === "string" ? detail.message : event.event),
    detail: event.detail,
  };
}

function isFailureStatusEvent(event: string, detail: Record<string, unknown>): boolean {
  if (detail.severity === "error") return true;
  return new Set([
    "max_budget_reached",
    "task_budget_reached",
    "model_request_failed",
    "tool_call_recovery_exhausted",
    "max_turns_reached",
    "max_output_recovery_exhausted",
    "empty_response",
    "content_filter",
    "unknown_finish_reason",
  ]).has(event);
}

function serializeTransportError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(error) };
}
