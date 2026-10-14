import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { AgentLoop, type AgentLoopSeedState } from "../../agent/loop/AgentLoop.js";
import type {
  AgentTurnCapabilities,
  ToolExecutionPort,
} from "../../agent/loop/AgentTurnCapabilities.js";
import type { AgentLoopRuntimeFactoryInput } from "../../agent/loop/AgentLoopRuntimeFactory.js";
import type { AgentLoopRuntimeFactory } from "../../agent/loop/AgentLoopRuntimeFactory.js";
import type { AgentRuntimeConfig } from "../../agent/runtime/AgentRuntimeConfig.js";
import type { AgentLoopRunner } from "../../agent/turn/TurnRunner.js";
import type { AgentEvent } from "../../agent/protocol/events.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../../agent/loop/AgentLoop.js";
import type { AgentModelOverride } from "../../agent/protocol/input.js";
import type { ModelExecutionContext, ToolPort } from "../../agent/modules/protocol.js";
import type { CanonicalMessage } from "../../model/index.js";
import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
} from "../../tool/index.js";
import { toolError } from "../../tool/index.js";

import { StaffDeckSopClient, StaffDeckSopClientError } from "./StaffDeckSopClient.js";
import { PortableSopHostClient, PortableSopRuntimeClient, type PortableSopReceipt } from "./PortableSopRuntimeClient.js";
import { StaffDeckSopDiscoveryClient } from "./StaffDeckSopDiscoveryClient.js";
import { loadStaffDeckSopDefinitions, parseSopNodeModel } from "./StaffDeckSopDefinitions.js";
import { SopStateStore } from "./SopStateStore.js";
import { SopNodeSessions, sopNodeSessionId } from "./SopNodeSessions.js";
import { OPTIONAL_KNOWLEDGE_SCHEMA, authorityError, validateOptionalKnowledgeInput,
  validateSopAuthorityProjection, withKnowledgeAuthority, type SopCapabilityAuthorityPort } from "../../composition/sopCapabilityAuthority.js";
import type {
  StaffDeckSopBundle,
  StaffDeckSopPrepareResponse,
  StaffDeckSopProposal,
  StaffDeckSopReplyDelivery,
  StaffDeckSopRuntimeClient,
  StaffDeckSopContextMode,
  SopRuntimeConfig,
  StaffDeckSopSubmitResult,
  StaffDeckSopDiscoveryPort,
} from "./types.js";
import type { SidecarModuleComposition } from "../../agent/modules/transport/sidecarHostModulePorts.js";

export const SUBMIT_SOP_STEP_RESULT_TOOL = "submit_step_result";

type SopSubmission = Readonly<{
  result: StaffDeckSopSubmitResult;
}>;

type SopAgentLoopOptions = Readonly<{
  profile: SopRuntimeConfig;
  bundle: StaffDeckSopBundle;
  client?: StaffDeckSopRuntimeClient;
  stateStore?: SopStateStore;
  authorityPort?: SopCapabilityAuthorityPort;
  /** Optional externally deployed loop. SOP remains a host-side decorator. */
  runnerFactory?: AgentLoopRuntimeFactory;
  sidecarModules?: SidecarModuleComposition;
  sidecarTransportContext?: AgentLoopRuntimeFactoryInput["sidecarTransportContext"];
  sessionStorage?: AgentLoopRuntimeFactoryInput["sessionStorage"];
  contextRuntime?: AgentLoopRuntimeFactoryInput["contextRuntime"];
  internalSessionPorts?: AgentLoopRuntimeFactoryInput["internalSessionPorts"];
}>;

/**
 * Adds the StaffDeck SOP control plane around, rather than into, PilotDeck's
 * native AgentLoop. Model, tools, context, transcript and session ownership
 * remain on the PilotDeck side of the boundary.
 */
export class SopAgentLoop implements AgentLoopRunner {
  private readonly stateStore: SopStateStore;
  private readonly client: StaffDeckSopRuntimeClient;
  private readonly submissions = new Map<string, SopSubmission>();
  private readonly selectedSops = new Map<string, string | undefined>();
  private readonly sessionContext = new AsyncLocalStorage<string>();
  private readonly discovery: StaffDeckSopDiscoveryPort | undefined;
  private readonly native: AgentLoopRunner;
  private readonly preparedSteps = new Map<string, StaffDeckSopPrepareResponse["step"]>();
  private readonly protocolCorrections = new Map<string, string>();
  private readonly collectInputs = new Map<string, string>();
  private readonly collectCorrectionTurns = new Set<string>();
  private readonly nodeSessions: SopNodeSessions;
  private nodeRunInput: AgentLoopInput | undefined;
  private nodeRunResult: AgentLoopRunResult | undefined;
  private nodeContext: AgentLoopRuntimeFactoryInput["contextRuntime"];
  private nodeModel: NonNullable<AgentLoopRuntimeFactoryInput["internalSessionPorts"]>["model"] | undefined;
  private nodeTools: ToolPort | undefined;
  private readonly preflightSteps = new Map<string, StaffDeckSopPrepareResponse>();
  private readonly nodeModelOverrides = new Map<string, Pick<AgentModelOverride, "provider" | "model">>();
  private readonly userInputs = new Map<string, CanonicalMessage | undefined>();

  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly capabilities: AgentTurnCapabilities,
    seedState: AgentLoopSeedState | undefined,
    private readonly options: SopAgentLoopOptions,
  ) {
    config.stopOnStructuredOutput = true;
    if (options.profile.hostAdapter !== "pilotdeck") assertRequiredSopTools(options.bundle, options.profile.defaultSopId, capabilities.toolExecution.list());
    const runtime = "contract" in options.profile && options.profile.contract === "sop.lifecycle/v3"
      ? new PortableSopRuntimeClient(options.profile.endpoint, { timeoutMs: options.profile.timeoutMs }) : undefined;
    this.stateStore = options.stateStore ?? new SopStateStore(join(config.staffDeckSop!.stateRoot, "sessions"), runtime);
    this.client = options.client ?? (runtime ? new PortableSopHostClient(runtime, options.profile.capabilityBindings, options.profile.runtimeSopScope) : new StaffDeckSopClient(options.profile.endpoint, {
      timeoutMs: options.profile.timeoutMs,
      ...("implementationId" in options.profile
        ? {
            manifestPath: options.profile.manifestPath,
            expectedManifest: {
              implementationId: options.profile.implementationId,
              contract: options.profile.contract,
              transport: options.profile.transport,
            },
          }
      : {}),
    }));
    this.discovery = options.profile.discoveryEndpoint && options.profile.discoveryAgentId && options.profile.discoveryApiKey
      ? new StaffDeckSopDiscoveryClient(
          options.profile.discoveryEndpoint,
          options.profile.discoveryAgentId,
          options.profile.discoveryApiKey,
          {
            path: options.profile.discoveryPath,
            timeoutMs: options.profile.discoveryTimeoutMs ?? options.profile.timeoutMs,
          },
        )
      : undefined;

    const controlPort = new SopControlToolPort({
      delegate: { list: () => capabilities.toolExecution.list(), executeAll: (calls, context, execution) =>
        (this.nodeTools ?? capabilities.toolExecution).executeAll(calls, context, execution) },
      client: this.client,
      stateStore: this.stateStore,
      capabilityBindings: options.profile.capabilityBindings,
      authorityPort: options.authorityPort,
      bundle: options.bundle,
      defaultSopId: options.profile.defaultSopId,
      selectedSopId: (sessionId) => this.selectedSops.get(sessionId),
      selectedSopForTools: () => {
        if (!this.discovery) return options.profile.defaultSopId;
        const sessionId = this.sessionContext.getStore();
        return sessionId ? this.selectedSops.get(sessionId) : undefined;
      },
      currentStepForTools: () => {
        const sessionId = this.sessionContext.getStore();
        return sessionId ? this.preparedSteps.get(sessionId) : undefined;
      },
      onSubmission: (sessionId, result) => this.submissions.set(sessionId, { result }),
      currentStep: (sessionId) => this.preparedSteps.get(sessionId),
      collectInput: (sessionId) => this.collectInputs.get(sessionId) ?? "",
      shouldReviewCollectWait: (sessionId, turnId) => {
        const key = `${sessionId}:${turnId}`;
        if (this.collectCorrectionTurns.has(key)) return false;
        this.collectCorrectionTurns.add(key);
        return true;
      },
    });
    const toolExecution: ToolExecutionPort = Object.freeze({
      list: () => controlPort.list(),
      executeAll: (calls, context, execution) => controlPort.executeAll(calls, context, execution),
      auditRecorder: capabilities.toolExecution.auditRecorder,
      fileHistory: capabilities.toolExecution.fileHistory,
      fileUpdateNotifier: capabilities.toolExecution.fileUpdateNotifier,
    });
    const contextPreparation = Object.freeze({
      prepareForModel: (input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0]) =>
        this.prepareContext(capabilities, input),
    });
    const wrappedCapabilities = Object.freeze({
      ...capabilities,
      model: Object.freeze({
        ...capabilities.model,
        execution: {
          prepare: (input: Parameters<typeof capabilities.model.execution.prepare>[0]) =>
            (this.nodeModel ?? capabilities.model.execution).prepare({ ...input, request: {
              ...input.request,
              ...sopModelTools(this.preparedSteps.get(input.context.sessionId), input.request.tools),
            } }),
          stream: (input: Parameters<typeof capabilities.model.execution.stream>[0]) => (this.nodeModel ?? capabilities.model.execution).stream({
            ...input,
            prepared: { ...input.prepared, request: { ...input.prepared.request,
              ...sopModelTools(this.preparedSteps.get(input.context.sessionId), input.prepared.request.tools),
            } },
          }),
        },
      }),
      toolExecution,
      contextPreparation,
      ...(capabilities.contextRecovery ? { contextRecovery: { recoverFromModelError:
        (input: Parameters<NonNullable<AgentTurnCapabilities["contextRecovery"]>["recoverFromModelError"]>[0]) =>
          (this.nodeContext?.recoverFromModelError?.bind(this.nodeContext) ?? capabilities.contextRecovery!.recoverFromModelError)(
            { ...input, sessionId: this.contextSessionId(input.sessionId) }) } } : {}),
      ...(capabilities.contextToolResults ? { contextToolResults: { applyToolResults:
        (input: Parameters<NonNullable<AgentTurnCapabilities["contextToolResults"]>["applyToolResults"]>[0]) =>
          (this.nodeContext?.applyToolResults?.bind(this.nodeContext) ?? capabilities.contextToolResults!.applyToolResults)(
            { ...input, sessionId: this.contextSessionId(input.sessionId) }) } } : {}),
      ...(capabilities.contextCompaction ? { contextCompaction: { tryAutoCompact:
        (input: Parameters<NonNullable<AgentTurnCapabilities["contextCompaction"]>["tryAutoCompact"]>[0]) =>
          (this.nodeContext?.tryAutoCompact?.bind(this.nodeContext) ?? capabilities.contextCompaction!.tryAutoCompact)({ ...input,
            sessionId: input.sessionId ? this.contextSessionId(input.sessionId) : input.sessionId }) } } : {}),
      ...(capabilities.contextCapture ? { contextCapture: { captureTurn:
        (input: Parameters<NonNullable<AgentTurnCapabilities["contextCapture"]>["captureTurn"]>[0]) =>
          (this.nodeContext?.captureTurn?.bind(this.nodeContext) ?? capabilities.contextCapture!.captureTurn)(
            { ...input, sessionId: this.contextSessionId(input.sessionId) }) } } : {}),
      tools: Object.freeze({
        ...capabilities.tools,
        port: controlPort,
      }),
    }) as AgentTurnCapabilities;
    this.native = options.runnerFactory
      ? options.runnerFactory({
          config,
          capabilities: wrappedCapabilities,
          sidecarModules: options.sidecarModules
            ? wrapSidecarModules(options.sidecarModules, controlPort, (input) => this.prepareContext(capabilities, input),
                (sessionId) => this.preparedSteps.get(sessionId), sessionId => this.contextSessionId(sessionId), () => this.nodeContext, () => this.nodeModel)
            : undefined,
          seedState,
          sidecarTransportContext: options.sidecarTransportContext,
        })
      : new AgentLoop(config, wrappedCapabilities, seedState);
    const self = this;
    this.nodeSessions = new SopNodeSessions({ cwd: config.cwd, stateRoot: options.profile.stateRoot,
      auditRecorder: capabilities.toolExecution.auditRecorder,
      storage: options.sessionStorage, context: options.contextRuntime, ports: options.internalSessionPorts, runner: {
        snapshotFileState: () => self.native.snapshotFileState(),
        async *run(nodeInput) {
          const parent = self.nodeRunInput!;
          let nativeInput: AgentLoopInput = { ...parent, messages: nodeInput.messages,
            onDurableMessage: nodeInput.onDurableMessage,
            onCompactPersisted: nodeInput.onCompactPersisted };
          let corrected = false;
          let previousResult: AgentLoopRunResult["result"] | undefined;
          while (true) {
            const iterator = self.native.run(nativeInput);
            let sawToolError = false;
            try {
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                const state = await self.stateStore.status(parent.sessionId);
                if (!sawToolError && !self.submissions.has(parent.sessionId)
                  && state?.state.status === "active" && next.value.result.stopReason === "completed"
                  && (nativeInput.maxTurns === undefined || next.value.result.turns < nativeInput.maxTurns)
                  && !next.value.result.structuredOutput) {
                  if (corrected) throw new Error("SOP_STEP_RESULT_REQUIRED: model ended without submitting the active node result");
                  corrected = true;
                  const step = self.preparedSteps.get(parent.sessionId)!;
                  self.protocolCorrections.set(parent.sessionId, sopStepKey(step.skillId, step.nodeId));
                  previousResult = next.value.result;
                  nativeInput = continueNodeInput(nativeInput, next.value);
                  if (self.options.runnerFactory) nativeInput = { ...nativeInput, execution: { ...nativeInput.execution!,
                    operationId: `${nativeInput.execution!.operationId}:correction` } };
                  break;
                }
                const completed = { ...next.value, result: mergeNodeResults(previousResult, next.value.result) };
                self.nodeRunResult = completed;
                yield { type: "turn_completed", sessionId: nodeInput.sessionId,
                  turnId: nodeInput.turnId, result: { ...completed.result, sessionId: nodeInput.sessionId } };
                return { ...completed, result: { ...completed.result, sessionId: nodeInput.sessionId } };
              }
              if (next.value.type === "tool_result" && next.value.result.type === "error"
                && next.value.result.error.code !== "invalid_tool_input") sawToolError = true;
              if (next.value.type === "turn_completed") continue;
              yield { ...next.value, sessionId: nodeInput.sessionId } as AgentEvent;
            }
            } finally { await iterator.return(undefined as never); }
          }
        },
      } });
  }

  async dispose(): Promise<void> {
    await this.nodeSessions.dispose();
    await this.native.dispose?.();
  }

  private contextSessionId(parentSessionId: string): string {
    const step = this.preparedSteps.get(parentSessionId);
    return step?.contextMode === "new_session"
      ? sopNodeSessionId(parentSessionId, step.skillId, step.nodeId) : parentSessionId;
  }

  snapshotFileState(): AgentLoopSeedState {
    return this.native.snapshotFileState();
  }

  seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    return this.native.seedReadState?.(filePath, mtimeMs) ?? Promise.resolve({ applied: false });
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.submissions.delete(input.sessionId);
    this.protocolCorrections.delete(input.sessionId);
    this.collectCorrectionTurns.delete(`${input.sessionId}:${input.turnId}`);
    this.collectInputs.set(input.sessionId, latestUserMessage(input.messages));
    this.userInputs.set(input.sessionId, latestUserMessageOnly(input.messages)[0]);
    const recoverableDelivery = await this.stateStore.replyDelivery(input.sessionId);
    if (recoverableDelivery) {
      const active = (await this.stateStore.status(input.sessionId))?.state.status === "active";
      const recovered = yield* this.deliverReply(input, recoverableDelivery, !active);
      if (!active) return recovered;
      input = { ...input, messages: recovered.messages };
    }
    await this.selectSop(input, this.discovery);
    let completed: AgentLoopRunResult;
    let delayedCompletion: Extract<AgentEvent, { type: "turn_completed" }> | undefined;
    const correctionsByStep = new Map<string, number>();
    let sawToolError = false;
    const visibleMessages = [...input.messages];
    const persistMain = input.onDurableMessage;
    input = { ...input, onDurableMessage: async message => {
      visibleMessages.push(message);
      await persistMain?.(message);
    } };
    let totalTurns = 0;
    let totalSpentUsd = 0;
    let totalUsage: AgentLoopRunResult["result"]["usage"] = {};
    const permissionDenials: AgentLoopRunResult["result"]["permissionDenials"] = [];
    let iterator = this.runNode(input);
    while (true) {
      const next = await this.sessionContext.run(input.sessionId, () => iterator.next());
      if (next.done) {
        completed = next.value;
        totalTurns += completed.result.turns;
        permissionDenials.push(...completed.result.permissionDenials);
        totalSpentUsd += completed.result.budget?.turnSpentUsd ?? 0;
        for (const [key, value] of Object.entries(completed.result.usage)) {
          if (typeof value === "number") (totalUsage as Record<string, unknown>)[key] =
            ((totalUsage as Record<string, number>)[key] ?? 0) + value;
        }
        const state = await this.stateStore.status(input.sessionId);
        if (state?.state.status === "active" && completed.result.stopReason === "completed"
          && input.maxTurns !== undefined && completed.result.turns >= input.maxTurns) {
          completed = { ...completed, result: { ...completed.result, type: "max_turns", stopReason: "max_turns" } };
          break;
        }
        if (state?.state.status === "active" && completed.result.structuredOutput) {
          // A successful submission ends only the internal node turn.
          input = continueNodeInput(input, completed);
          this.protocolCorrections.delete(input.sessionId);
          iterator = this.runNode(input);
          continue;
        }
        if (!sawToolError && this.selectedSops.get(input.sessionId)
          && !this.submissions.has(input.sessionId) && state?.state.status === "active"
          && completed.result.stopReason === "completed") {
          // A provider can ignore tool_choice and end with prose. Give each
          // active node one correction in this turn, without fabricating a result.
          const stepKey = sopStepKey(
            state.state.active_skill_id ?? state.state.selected_skill_id ?? this.selectedSops.get(input.sessionId),
            state.state.active_step_id ?? this.preparedSteps.get(input.sessionId)?.nodeId,
          );
          const attempted = correctionsByStep.get(stepKey) ?? 0;
          if (attempted >= 1) throw new Error("SOP_STEP_RESULT_REQUIRED: model ended without submitting the active node result");
          correctionsByStep.set(stepKey, attempted + 1);
          this.protocolCorrections.set(input.sessionId, stepKey);
          input = continueNodeInput(input, completed);
          iterator = this.runNode(input);
          continue;
        }
        break;
      }
      if (next.value.type === "tool_result" && next.value.result.type === "error"
        && next.value.result.error.code !== "invalid_tool_input") sawToolError = true;
      if (next.value.type === "turn_completed") {
        delayedCompletion = next.value;
        continue;
      }
      yield next.value;
    }
    completed = { ...completed, result: { ...completed.result, turns: totalTurns, usage: totalUsage, permissionDenials,
      ...(completed.result.budget ? { budget: { ...completed.result.budget, turnSpentUsd: totalSpentUsd } } : {}) } };

    const submission = this.submissions.get(input.sessionId);
    if (!submission) {
      if (delayedCompletion) yield { ...delayedCompletion, result: completed.result };
      return { ...completed, messages: visibleMessages };
    }
    const finalMessage = replyMessage(submission.result, input.turnId);
    await input.onDurableMessage?.(finalMessage);
    await this.stateStore.markReplyDurable(input.sessionId, input.turnId);
    yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: finalMessage };
    const rewritten: AgentLoopRunResult = {
      result: {
        ...completed.result,
        finalMessage,
        structuredOutput: {
          sop: submission.result,
        },
      },
      messages: visibleMessages,
    };
    if (delayedCompletion) {
      yield { ...delayedCompletion, result: rewritten.result };
    }
    await this.stateStore.clearReplyDelivery(input.sessionId, input.turnId);
    return rewritten;
  }

  private async *runNode(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.nodeContext = undefined;
    this.nodeModel = undefined;
    this.nodeTools = undefined;
    const prepared = await this.prepareStep({ sessionId: input.sessionId, turnId: input.turnId,
      cwd: this.config.cwd, provider: this.config.provider, model: this.config.model,
      permissionMode: this.config.permissionMode, runMode: this.config.runMode ?? "agent",
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages: input.messages, tools: [], abortSignal: input.abortSignal });
    const nodeModelOverride = this.nodeModelOverrides.get(input.sessionId);
    const nodeInput = { ...input,
      ...(nodeModelOverride ? { modelOverride: { ...input.modelOverride, ...nodeModelOverride } } : {}) };
    if (prepared && this.options.runnerFactory) {
      nodeInput.execution = { ...nodeInput.execution,
        runId: nodeInput.execution?.runId ?? `sop:${nodeInput.sessionId}:${nodeInput.turnId}`,
        operationId: `${nodeInput.execution?.operationId ?? nodeInput.turnId}:sop-node:${encodeURIComponent(prepared.step.skillId)}:${encodeURIComponent(prepared.step.nodeId)}` };
    }
    if (prepared) this.preflightSteps.set(nodeInput.sessionId, prepared);
    if (!prepared || prepared.step.contextMode === "inherit") return yield* this.native.run(nodeInput);
    const runtime = await this.nodeSessions.get(nodeInput.sessionId, prepared.step.skillId, prepared.step.nodeId);
    const node = runtime.session;
    this.nodeContext = runtime.context;
    this.nodeModel = runtime.model;
    this.nodeTools = runtime.tools;
    this.nodeRunInput = nodeInput;
    this.nodeRunResult = undefined;
    const current = this.userInputs.get(input.sessionId);
    const iterator = node.submit({ type: "blocks", content: current?.content ?? [] }, {
      turnId: nodeInput.turnId, execution: nodeInput.execution, maxTurns: nodeInput.maxTurns,
      modelOverride: nodeInput.modelOverride,
      metadata: { parentSessionId: nodeInput.sessionId },
    });
    for await (const event of iterator) {
      if (event.type === "turn_started" || event.type === "input_accepted") continue;
      yield { ...event, sessionId: input.sessionId,
        ...(event.type === "turn_completed" ? { result: { ...event.result, sessionId: input.sessionId } } : {}) } as AgentEvent;
    }
    const result = this.nodeRunResult as AgentLoopRunResult | undefined;
    if (!result) {
      throw new Error("SOP_NODE_SESSION_FAILED: internal node turn did not produce a result");
    }
    return result;
  }

  private async *deliverReply(
    input: AgentLoopInput,
    delivery: StaffDeckSopReplyDelivery,
    finishTurn = true,
  ): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    const finalMessage = replyMessage(delivery.result, finishTurn ? input.turnId : `${input.turnId}:recovered-step`);
    if (delivery.phase === "pending" || delivery.turnId !== input.turnId) {
      await input.onDurableMessage?.(finalMessage);
      await this.stateStore.markReplyDurable(input.sessionId, delivery.turnId, input.turnId);
      yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: finalMessage };
    }
    const now = new Date().toISOString();
    const result: AgentLoopRunResult["result"] = {
      type: "success",
      sessionId: input.sessionId,
      turnId: input.turnId,
      finalMessage,
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: now,
      completedAt: now,
      structuredOutput: { sop: delivery.result },
    };
    if (finishTurn) yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
    await this.stateStore.clearReplyDelivery(input.sessionId, input.turnId);
    return { result, messages: appendReplyOnce(input.messages, finalMessage) };
  }

  private async prepareContext(
    capabilities: AgentTurnCapabilities,
    input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0],
  ) {
    const preflight = this.preflightSteps.get(input.sessionId);
    this.preflightSteps.delete(input.sessionId);
    const prepared = preflight ?? await this.prepareStep(input);
    if (!prepared) return capabilities.contextPreparation.prepareForModel(input);
    const modelContext = await this.stateStore.modelContext(input.sessionId);
    return (this.nodeContext ?? capabilities.contextPreparation).prepareForModel({
      ...input,
      sessionId: prepared.step.contextMode === "new_session"
        ? sopNodeSessionId(input.sessionId, prepared.step.skillId, prepared.step.nodeId) : input.sessionId,
      appendSystemPrompt: joinPrompt(input.appendSystemPrompt, joinPrompt(renderSopInstruction(prepared, modelContext),
        this.protocolCorrections.get(input.sessionId) === sopStepKey(prepared.step.skillId, prepared.step.nodeId)
          ? prepared.step.isTerminal && !prepared.step.declaresHandoff && prepared.step.expectedUserInfo.length === 0
            ? "SOP_STEP_RESULT_REQUIRED: The previous assistant text was only a draft. The final SOP node is still active. Call submit_step_result now with status completed, the final answer in replyFragment, slotUpdates {}, and no nextStepId. Do not repeat the draft as plain assistant text."
            : "SOP_STEP_RESULT_REQUIRED: Your previous response did not submit the current SOP node result. Text cannot create an approval or missing-field wait. Follow the current node contract and call submit_step_result with your actual result before ending. Do not claim a persisted wait or completion without a successful tool receipt."
          : "")),
    });
  }

  private async prepareStep(input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0]) {
    const capabilities = this.capabilities;
    const selectedSopId = this.selectedSops.get(input.sessionId);
    this.preparedSteps.delete(input.sessionId);
    this.nodeModelOverrides.delete(input.sessionId);
    if (!selectedSopId) return undefined;
    let persisted = await this.stateStore.loadOrCreate(
      input.sessionId,
      this.options.bundle,
      selectedSopId,
    );
    if (isTerminalSopStatus(persisted.state.status)) {
      return undefined;
    }
    if (this.stateStore.runtime && persisted.state.status === "awaiting_user") {
      const wait = persisted.state.awaiting_input_json as Record<string, unknown>;
      await this.stateStore.runtime.resume({ protocolVersion: "3.0", sessionId: input.sessionId,
        requestId: `sop.user-resume:${input.turnId}:${persisted.revision}`, operationId: "sop.user-resume",
        turnId: input.turnId, expectedRevision: persisted.revision, waitId: String(wait.wait_id),
        response: { source: "user", message: this.collectInputs.get(input.sessionId) ?? "" } });
      persisted = await this.stateStore.loadOrCreate(input.sessionId, persisted.bundle, selectedSopId);
    }
    const ownerPrepared = await this.client.prepare({
      bundle: persisted.bundle,
      state: persisted.state,
      context: {
        runId: `sop:${input.sessionId}:${input.turnId}`,
        operationId: `sop.prepare:${input.sessionId}:${input.turnId}`,
        requestId: `sop.prepare:${input.sessionId}:${input.turnId}:${input.stepId ?? 0}:${persisted.revision}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        idempotencyKey: `sop.prepare:${input.sessionId}:${input.turnId}:${input.stepId ?? 0}:${persisted.revision}`,
        expectedRevision: persisted.revision,
      },
      signal: input.abortSignal,
    });
    // The owner exposes a knowledge_query node without mapping its domain
    // binding to the PilotDeck tool name. Keep that host mapping here.
    let prepared = this.options.profile.hostAdapter !== "pilotdeck" && ownerPrepared.step.node.type === "knowledge_query"
      ? { ...ownerPrepared, step: { ...ownerPrepared.step,
          requiredToolNames: [...new Set([...ownerPrepared.step.requiredToolNames, "knowledge_query"])] } }
      : ownerPrepared;
    if (this.options.profile.hostAdapter === "pilotdeck") {
      const requirements = (prepared.step as unknown as { capabilityRequirements?: { capability_id: string; kind: string; required: boolean }[] }).capabilityRequirements ?? [];
      const tools = new Set(capabilities.toolExecution.list().map(tool => tool.name));
      for (const toolName of prepared.step.requiredToolNames) {
        if (!tools.has(toolName)) throw Object.assign(new Error(`Required tool unavailable: ${toolName}`), { code: "SOP_CAPABILITY_BINDING_UNAVAILABLE" });
      }
      for (const requirement of requirements.filter(item => item.required)) {
        const binding = this.options.profile.capabilityBindings?.find(item => item.capabilityId === requirement.capability_id && item.kind === requirement.kind);
        if (!binding || !tools.has(binding.toolName)) throw Object.assign(new Error(`Required ${requirement.kind} binding unavailable: ${requirement.capability_id}`), { code: "SOP_CAPABILITY_BINDING_UNAVAILABLE" });
      }
    }
    // Portable output supplies no authority, even if it contains additional fields.
    const { optionalKnowledge: _untrusted, optionalKnowledgeUnavailable: _reason, ...ownerStep } = prepared.step;
    prepared = { ...prepared, step: ownerStep };
    const contextMode = resolveContextMode(prepared.step, this.options.profile, persisted.bundle, prepared.step.skillId);
    prepared = { ...prepared, step: { ...prepared.step, contextMode } };
    const nodeModelOverride = resolveNodeModelOverride(prepared.step, persisted.bundle, prepared.step.skillId);
    if (nodeModelOverride) {
      try {
        await capabilities.model.execution.validateSelection?.(nodeModelOverride);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "SOP_NODE_MODEL_UNAVAILABLE";
        throw new StaffDeckSopClientError(code,
          `${code}: SOP node '${prepared.step.nodeId}' model '${nodeModelOverride.provider}/${nodeModelOverride.model}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const saved = await this.stateStore.replace(input.sessionId, persisted.bundle, prepared.state,
      this.stateStore.runtime ? undefined : persisted.revision);
    if (this.options.authorityPort && prepared.step.node.type === "response"
      && capabilities.toolExecution.list().some(tool => tool.name === "knowledge_query")) {
      const context = { sessionKey: input.sessionId, projectKey: input.cwd,
        expectedRevision: saved.revision, requestId: `sop.authority:${input.sessionId}:${input.turnId}:${saved.revision}` };
      try {
        const projection = validateSopAuthorityProjection(await this.options.authorityPort.resolve(context, input.abortSignal), context);
        if (projection.sopId !== prepared.step.skillId || projection.sopVersion !== prepared.step.version
          || projection.nodeId !== prepared.step.nodeId) throw authorityError("SOP_AUTHORITY_PIN_MISMATCH");
        await this.stateStore.authority(input.sessionId, saved.revision);
        if (projection.optionalCapabilities.length > 0) prepared = { ...prepared, step: { ...prepared.step, optionalKnowledge: projection } };
      } catch (error) {
        if (input.abortSignal?.aborted || (error as { code?: string }).code === "SOP_REVISION_CONFLICT") throw error;
        prepared = { ...prepared, step: { ...prepared.step, optionalKnowledgeUnavailable:
          (error as { code?: string }).code ?? "SOP_AUTHORITY_UNAVAILABLE" } };
      }
    }
    this.preparedSteps.set(input.sessionId, prepared.step);
    if (nodeModelOverride) this.nodeModelOverrides.set(input.sessionId, nodeModelOverride);
    return prepared;
  }

  private async selectSop(
    input: AgentLoopInput,
    discovery: StaffDeckSopDiscoveryPort | undefined,
  ): Promise<void> {
    const existing = await this.stateStore.status(input.sessionId);
    const persistedSelection = existing?.state.selected_skill_id ?? existing?.state.active_skill_id;
    if (persistedSelection) {
      if (this.options.profile.hostAdapter !== "pilotdeck") ensureBundleSop(this.options.bundle, persistedSelection);
      this.selectedSops.set(input.sessionId, persistedSelection);
      return;
    }
    if (this.options.profile.hostAdapter === "pilotdeck") {
      const definitions = await this.stateStore.runtime!.catalog();
      const sops = definitions.map(item => ({ id: item.sop_id, ...item }));
      (this.options.bundle as { sops: readonly Record<string, unknown>[] }).sops = sops;
      const requested = latestUserMessage(input.messages).match(/(?:\/sop\s+)([\w.-]+)/u)?.[1] ?? this.options.profile.defaultSopId;
      ensureBundleSop(this.options.bundle, requested);
      this.selectedSops.set(input.sessionId, requested);
      return;
    }
    if (!discovery) {
      this.selectedSops.set(input.sessionId, this.options.profile.defaultSopId);
      return;
    }
    const result = await discovery.route({
      message: latestUserMessage(input.messages),
      sessionId: input.sessionId,
    });
    const selected = result.selectedSopId ?? undefined;
    if (selected && result.candidateSopIds && !result.candidateSopIds.includes(selected)) {
      throw Object.assign(
        new Error(`StaffDeck SOP discovery selected '${selected}', but StaffDeck did not expose it as a candidate.`),
        { code: "SOP_DISCOVERY_SELECTION_NOT_VISIBLE", selectedSopId: selected },
      );
    }
    if (selected) ensureBundleSop(this.options.bundle, selected);
    this.selectedSops.set(input.sessionId, selected);
  }
}

/** Creates a native PilotDeck loop decorated with one StaffDeck SOP profile. */
export function createStaffDeckSopAgentLoop(
  input: AgentLoopRuntimeFactoryInput,
  profile: SopRuntimeConfig,
  runnerFactory?: AgentLoopRuntimeFactory,
  authorityPort?: SopCapabilityAuthorityPort,
): SopAgentLoop {
  const bundle = profile.hostAdapter === "pilotdeck" ? { sops: [] } : loadStaffDeckSopDefinitions(profile.definitionsPath);
  if (profile.hostAdapter !== "pilotdeck" && !bundle.sops.some((definition) => sopId(definition) === profile.defaultSopId)) {
    throw new Error(`StaffDeck SOP defaultSopId '${profile.defaultSopId}' is not present in ${profile.definitionsPath}.`);
  }
  return new SopAgentLoop(input.config, input.capabilities, input.seedState, {
    profile,
    bundle,
    ...(authorityPort ? { authorityPort } : {}),
    ...(runnerFactory ? { runnerFactory } : {}),
    ...(input.sidecarModules ? { sidecarModules: input.sidecarModules } : {}),
    ...(input.sidecarTransportContext ? { sidecarTransportContext: input.sidecarTransportContext } : {}),
    ...(input.sessionStorage ? { sessionStorage: input.sessionStorage } : {}),
    ...(input.contextRuntime ? { contextRuntime: input.contextRuntime } : {}),
    ...(input.internalSessionPorts ? { internalSessionPorts: input.internalSessionPorts } : {}),
  });
}

function wrapSidecarModules(
  modules: SidecarModuleComposition,
  controlPort: ToolPort,
  prepareForModel: (input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0]) => ReturnType<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>,
  currentStep: (sessionId: string) => StaffDeckSopPrepareResponse["step"] | undefined,
  contextSessionId: (sessionId: string) => string,
  nodeContext: () => AgentLoopRuntimeFactoryInput["contextRuntime"],
  nodeModel: () => NonNullable<AgentLoopRuntimeFactoryInput["internalSessionPorts"]>["model"] | undefined,
): SidecarModuleComposition {
  const wrapModelExecution = (execution: typeof modules.model.execution) => ({
    prepare: (input: Parameters<typeof modules.model.execution.prepare>[0]) => execution.prepare({
      ...input, request: { ...input.request, ...sopModelTools(currentStep(input.context.sessionId), input.request.tools) },
    }),
    stream: (input: Parameters<typeof modules.model.execution.stream>[0]) => execution.stream({
      ...input, prepared: { ...input.prepared, request: { ...input.prepared.request,
        ...sopModelTools(currentStep(input.context.sessionId), input.prepared.request.tools),
      } },
    }),
  });
  return Object.freeze({
    ...modules,
    model: Object.freeze({
      ...modules.model,
      execution: {
        prepare: input => wrapModelExecution(nodeModel() ?? modules.model.execution).prepare(input),
        stream: input => wrapModelExecution(nodeModel() ?? modules.model.execution).stream(input),
      } as typeof modules.model.execution,
      // Retain parent routing state while binding admissions to the active recorder.
      bindTurn: (input: Parameters<NonNullable<typeof modules.model.bindTurn>>[0]) => {
        const execution = nodeModel() ?? modules.model.execution;
        const bound = modules.model.bindTurn?.(input, execution) ?? { ...modules.model, execution };
        return { ...bound, execution: wrapModelExecution(bound.execution) };
      },
    }),
    capability: Object.freeze({
      ...modules.capability,
      execution: controlPort,
    }),
    ...(modules.context
      ? {
          context: Object.freeze({
            ...modules.context,
            execution: Object.freeze({
              ...modules.context.execution,
              prepareForModel,
              ...(modules.context.execution.applyToolResults ? { applyToolResults:
                (input: Parameters<NonNullable<typeof modules.context.execution.applyToolResults>>[0]) =>
                  (nodeContext()?.applyToolResults?.bind(nodeContext()) ?? modules.context!.execution.applyToolResults!)(
                    { ...input, sessionId: contextSessionId(input.sessionId) }) } : {}),
              ...(modules.context.execution.recoverFromModelError ? { recoverFromModelError:
                (input: Parameters<NonNullable<typeof modules.context.execution.recoverFromModelError>>[0]) =>
                  (nodeContext()?.recoverFromModelError?.bind(nodeContext()) ?? modules.context!.execution.recoverFromModelError!)(
                    { ...input, sessionId: contextSessionId(input.sessionId) }) } : {}),
              ...(modules.context.execution.tryAutoCompact ? { tryAutoCompact:
                (input: Parameters<NonNullable<typeof modules.context.execution.tryAutoCompact>>[0]) =>
                  (nodeContext()?.tryAutoCompact?.bind(nodeContext()) ?? modules.context!.execution.tryAutoCompact!)({ ...input,
                    sessionId: input.sessionId ? contextSessionId(input.sessionId) : input.sessionId }) } : {}),
              ...(modules.context.execution.captureTurn ? { captureTurn:
                (input: Parameters<NonNullable<typeof modules.context.execution.captureTurn>>[0]) =>
                  (nodeContext()?.captureTurn?.bind(nodeContext()) ?? modules.context!.execution.captureTurn!)(
                    { ...input, sessionId: contextSessionId(input.sessionId) }) } : {}),
            }),
          }),
        }
      : {}),
  });
}

type SopControlToolPortOptions = Readonly<{
  delegate: ToolPort;
  client: StaffDeckSopRuntimeClient;
  stateStore: SopStateStore;
  capabilityBindings?: SopRuntimeConfig["capabilityBindings"];
  authorityPort?: SopCapabilityAuthorityPort;
  bundle: StaffDeckSopBundle;
  defaultSopId: string;
  selectedSopId(sessionId: string): string | undefined;
  currentStep(sessionId: string): StaffDeckSopPrepareResponse["step"] | undefined;
  collectInput(sessionId: string): string;
  shouldReviewCollectWait(sessionId: string, turnId: string): boolean;
  selectedSopForTools(): string | undefined;
  currentStepForTools(): StaffDeckSopPrepareResponse["step"] | undefined;
  onSubmission(sessionId: string, result: StaffDeckSopSubmitResult): void;
}>;

class SopControlToolPort implements ToolPort {
  constructor(private readonly options: SopControlToolPortOptions) {}

  list(): PilotDeckToolDefinition[] {
    const tools = this.options.delegate.list();
    if (tools.some((tool) => tool.name === SUBMIT_SOP_STEP_RESULT_TOOL)) {
      throw new Error(`${SUBMIT_SOP_STEP_RESULT_TOOL} is reserved by the StaffDeck SOP runtime.`);
    }
    if (!this.options.selectedSopForTools()) return tools;
    const step = this.options.currentStepForTools();
    if (!step) return tools;
    return step.requiredToolNames.length === 0
      ? [...(step.optionalKnowledge ? tools.filter(tool => tool.name === "knowledge_query")
          .map(tool => ({ ...tool, inputSchema: OPTIONAL_KNOWLEDGE_SCHEMA })) : []), submitSopStepResultTool()]
      : [...tools, submitSopStepResultTool()];
  }

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
    execution: ModelExecutionContext,
  ): Promise<PilotDeckToolResult[]> {
    const controls = calls.filter((call) => call.name === SUBMIT_SOP_STEP_RESULT_TOOL);
    const ordinary = calls.filter((call) => call.name !== SUBMIT_SOP_STEP_RESULT_TOOL);
    const step = this.options.currentStep(execution.sessionId);
    let ordinaryResults: PilotDeckToolResult[] = [];
    if (ordinary.length > 0 && step && this.options.selectedSopId(execution.sessionId)
      && (step.requiredToolNames.length === 0 || (step.node.type === 'response' && this.options.authorityPort))) {
      for (const call of ordinary) {
        if (call.name !== 'knowledge_query' && step.requiredToolNames.length > 0) {
          ordinaryResults.push(...await this.options.delegate.executeAll([call], context, execution));
          continue;
        }
        try {
          const projection = step?.optionalKnowledge;
          if (call.name !== "knowledge_query" || !projection || !this.options.authorityPort) throw authorityError("SOP_AUTHORITY_TOOL_UNAVAILABLE");
          validateOptionalKnowledgeInput(call.input);
          await this.options.stateStore.authority(execution.sessionId, projection.context.expectedRevision);
          const fresh = validateSopAuthorityProjection(await this.options.authorityPort.resolve(projection.context, execution.abortSignal), projection.context);
          if (fresh.snapshotId !== projection.snapshotId || fresh.sopId !== projection.sopId
            || fresh.sopVersion !== projection.sopVersion || fresh.nodeId !== projection.nodeId
            || fresh.registryGeneration !== projection.registryGeneration || fresh.optionalCapabilities.length === 0) throw authorityError("SOP_AUTHORITY_STALE");
          await this.options.stateStore.authority(execution.sessionId, projection.context.expectedRevision);
          const results = await withKnowledgeAuthority({ ...projection.context, snapshotId: projection.snapshotId,
            registryGeneration: projection.registryGeneration }, () => this.options.delegate.executeAll([call], context, execution));
          ordinaryResults.push(...results);
        } catch (error) {
          const code = (error as { code?: string }).code ?? "SOP_AUTHORITY_UNAVAILABLE";
          ordinaryResults.push({ ...controlError(call, code), toolName: call.name });
        }
      }
    } else if (ordinary.length > 0) {
      ordinaryResults = await this.options.delegate.executeAll(ordinary, context, execution);
    }
    const resultByCallId = new Map(ordinaryResults.map((result) => [result.toolCallId, result]));

    const selectedSopId = this.options.selectedSopId(execution.sessionId);
    if (selectedSopId && ordinaryResults.some((result) => result.type === "success")) {
      await this.options.stateStore.recordSuccessfulTools(
        execution.sessionId,
        this.options.bundle,
        selectedSopId,
        ordinaryResults
          .filter((result): result is Extract<PilotDeckToolResult, { type: "success" }> => result.type === "success")
          .map((result) => result.toolName),
        ordinaryResults.filter(result => result.type === "success").flatMap(result => {
          const bindings = this.options.capabilityBindings?.filter(binding => binding.toolName === result.toolName) ?? [];
          return [...new Set([result.toolName, ...bindings.map(binding => binding.capabilityId)])].map(capabilityId => ({
          capabilityId, operationId: this.options.stateStore.runtime
            ? `${execution.turnId}:${step?.nodeId}:${result.toolCallId}:${capabilityId}` : result.toolCallId,
          nodeId: step?.nodeId ?? "", sessionId: execution.sessionId, turnId: execution.turnId,
          status: "succeeded" as const, evidence: { toolCallId: result.toolCallId },
        })); }),
      );
    }

    for (const call of controls) {
      const result = ordinary.length > 0
        ? controlError(call, "Call submit_step_result only after the preceding tool results are available to you.")
        : await this.submit(call, execution);
      resultByCallId.set(call.id, result);
    }
    return calls.map((call) => resultByCallId.get(call.id) ?? controlError(call, "Tool execution produced no result."));
  }

  private async submit(call: PilotDeckToolCall, execution: ModelExecutionContext): Promise<PilotDeckToolResult> {
    if (!this.options.selectedSopId(execution.sessionId)) {
      return controlError(call, "No StaffDeck SOP is selected for this session.");
    }
    let proposal = parseProposal(call.input);
    if (!proposal) return controlError(call, "submit_step_result requires a valid status, non-empty replyFragment, and correctly typed known fields.", "invalid_tool_input");
    try {
      const persisted = await this.options.stateStore.loadOrCreate(
        execution.sessionId,
        this.options.bundle,
        this.options.selectedSopId(execution.sessionId) ?? this.options.defaultSopId,
      );
      const currentStep = this.options.currentStep(execution.sessionId);
      if (currentStep && currentStep.nodeId === persisted.state.active_step_id) {
        for (const field of currentStep.expectedUserInfo) {
          if (Object.hasOwn(proposal.slotUpdates ?? {}, field)
            && slotFilled(persisted.state.slots_json?.[field])
            && !slotFilled(proposal.slotUpdates?.[field])) {
            return controlError(call, `REQUIRED_SLOT_ERASURE: ${field} is already filled; an empty update cannot erase it.`, "invalid_tool_input");
          }
        }
      }
      if (proposal.status === "handoff" && currentStep && currentStep.nodeId === persisted.state.active_step_id && !currentStep.declaresHandoff) {
        return controlError(call, "HANDOFF_NOT_DECLARED: complete the current evidence step and advance to the declared approval node before creating handoff.", "invalid_tool_input");
      }
      if (proposal.status === "awaiting_user" && currentStep && currentStep.nodeId === persisted.state.active_step_id && currentStep.declaresHandoff) {
        return controlError(call, "HANDOFF_REQUIRED: this node declares a resumable human approval handoff. Submit handoff to wait for the responsible person's reply; awaiting_user cannot create that approval wait.", "invalid_tool_input");
      }
      if (proposal.nextStepId
        && currentStep
        && currentStep.nodeId === persisted.state.active_step_id
        && !currentStep.allowedNextStepIds.includes(proposal.nextStepId)) {
        const allowed = currentStep.allowedNextStepIds.length > 0
          ? currentStep.allowedNextStepIds.join(", ")
          : "none (this node is terminal or must remain active)";
        return controlError(
          call,
          `SOP_INVALID_TRANSITION: nextStepId '${proposal.nextStepId}' is not declared from '${currentStep.nodeId}'. Allowed nextStepId values: ${allowed}. Do not invent a transition; preserve the current state and submit the declared result or ask for the missing information.`,
          "invalid_tool_input",
          {
            activeStepId: currentStep.nodeId,
            requestedNextStepId: proposal.nextStepId,
            allowedNextStepIds: currentStep.allowedNextStepIds,
          },
        );
      }
      if (proposal.status === "awaiting_user") {
        if (proposal.nextStepId) return controlError(call, "AWAITING_USER_CANNOT_ADVANCE: remove nextStepId and retain the current step.", "invalid_tool_input");
        if (currentStep && currentStep.nodeId === persisted.state.active_step_id) {
          const slots = { ...persisted.state.slots_json, ...proposal.slotUpdates };
          const missing = missingFields(currentStep.expectedUserInfo, slots);
          const type = currentStep.node.type;
          if (missing.length > 0 && type === "collect_info"
            && (persisted.state.status === "awaiting_user" || Object.keys(proposal.slotUpdates ?? {}).length === 0)
            && this.options.collectInput(execution.sessionId).trim()
            && this.options.shouldReviewCollectWait(execution.sessionId, execution.turnId)) {
            return controlError(call,
              `COLLECT_FIELDS_CHECK: Before waiting, re-read this turn's user message: ${JSON.stringify(this.options.collectInput(execution.sessionId))}. `
              + `Persisted slots: ${JSON.stringify(persisted.state.slots_json ?? {})}. Your proposal still leaves these fields missing: ${missing.join(", ")}. `
              + `Extract every explicitly supplied value into slotUpdates using these exact keys: ${currentStep.expectedUserInfo.join(", ")}. `
              + "If a field is genuinely absent, resubmit awaiting_user for only that field; do not invent a value or repeat fields already supplied.",
              "invalid_tool_input");
          }
          if (missing.length === 0 && (currentStep.expectedUserInfo.length > 0
            || !currentStep.allowedActions.some((action) => action === "ask_user" || action === "ask_missing"))) {
            return controlError(call, "STEP_MUST_ADVANCE: required fields are complete. Submit completed to an allowed next step; approval belongs to the declared handoff node.", "invalid_tool_input");
          }
          if (type === "collect_info" && missing.length > 0) {
            proposal = { ...proposal, replyFragment: missingFieldsReply(missing) };
          }
        }
      }
      if (proposal.status === "completed" && currentStep && currentStep.nodeId === persisted.state.active_step_id
        && currentStep.isTerminal && currentStep.expectedUserInfo.length === 0
        && !currentStep.allowedActions.some((action) => action === "ask_user" || action === "ask_missing")
        && claimsUnresolvedUserWait(proposal.replyFragment)) {
        return controlError(call,
          "FINAL_REPLY_CONTRADICTS_COMPLETION: this terminal step has no missing user fields, but replyFragment says progress is blocked or asks the user for missing information. Rewrite the final answer from the current step instruction and known facts, then submit completed without a nextStepId. Do not reuse the rejected waiting reply.",
          "invalid_tool_input");
      }
      const successfulToolNames = Array.isArray(persisted.state.successful_tool_names)
        ? persisted.state.successful_tool_names.filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
      if (proposal.status === "completed" && currentStep?.node.type === "knowledge_query"
        && currentStep.requiredToolNames.includes("knowledge_query")
        && !successfulToolNames.includes("knowledge_query")) {
        return controlError(call, "REQUIRED_CAPABILITY_NOT_INVOKED: the current knowledge node requires a successful knowledge_query receipt before completion.", "invalid_tool_input");
      }
      const submitted = await this.options.client.submit({
        bundle: persisted.bundle,
        state: persisted.state,
        proposal,
        successfulToolNames,
        receipts: (Array.isArray(persisted.state.capability_receipts) ? persisted.state.capability_receipts : [])
          .filter((receipt: PortableSopReceipt) => receipt.turnId === execution.turnId
            && (!this.options.stateStore.runtime || !currentStep
              || (currentStep as unknown as { requiredCapabilityIds?: string[] }).requiredCapabilityIds?.includes(receipt.capabilityId)
              || (currentStep as unknown as { capabilityRequirements?: { capability_id: string }[] }).capabilityRequirements
                ?.some(item => item.capability_id === receipt.capabilityId))),
        context: {
          runId: execution.runId,
          operationId: execution.operationId ?? `sop.submit:${execution.sessionId}:${execution.turnId}`,
          requestId: `sop.submit:${this.options.stateStore.runtime ? `${execution.turnId}:${currentStep?.nodeId}:${call.id}` : call.id}`,
          sessionId: execution.sessionId,
          turnId: execution.turnId,
          idempotencyKey: this.options.stateStore.runtime ? `${execution.turnId}:${currentStep?.nodeId}:${call.id}` : call.id,
          deadlineAt: execution.operationDeadline,
          expectedRevision: persisted.revision,
        },
        signal: execution.abortSignal,
      });
      await this.options.stateStore.commitSubmission(
        execution.sessionId,
        persisted.bundle,
        submitted.state,
        persisted.revision,
        execution.turnId,
        submitted.result,
      );
      // The decorator advances active SOPs after this internal node turn ends.
      const finishTurn = true;
      if (submitted.state.status !== "active") this.options.onSubmission(execution.sessionId, submitted.result);
      else await this.options.stateStore.clearReplyDelivery(execution.sessionId, execution.turnId);
      return controlSuccess(call, submitted.result, {
        submittedStepId: persisted.state.active_step_id ?? null,
        activeStepId: submitted.state.active_step_id ?? null,
        sopStatus: submitted.state.status ?? null,
        finishTurn,
      });
    } catch (error) {
      const sopError = describeSopError(error);
      return controlError(call, `[${sopError.code}] ${sopError.message}`, sopError.toolCode, sopError.details);
    }
  }
}

function describeSopError(error: unknown): {
  code: string;
  message: string;
  toolCode: "tool_aborted" | "tool_execution_failed";
  details: Record<string, unknown>;
} {
  const code = error instanceof StaffDeckSopClientError
    ? error.code
    : isRecord(error) && typeof error.code === "string" ? error.code : "SOP_RUNTIME_REJECTED";
  const message = error instanceof Error ? error.message : String(error);
  const retryability = error instanceof StaffDeckSopClientError ? error.retryability ?? "unsafe" : "unsafe";
  const ownerDetails = error instanceof StaffDeckSopClientError ? error.details : undefined;
  return {
    code,
    message,
    toolCode: code === "SOP_RUNTIME_CANCELLED" ? "tool_aborted" : "tool_execution_failed",
    details: {
      ...(ownerDetails ?? {}),
      sopRuntime: { code, message, retryability, details: ownerDetails ?? {} },
    },
  };
}

function replyMessage(result: StaffDeckSopSubmitResult, turnId: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: result.replyFragment }],
    metadata: { purpose: "staffdeck_sop_reply", transientId: `staffdeck-sop-reply:${turnId}` },
  };
}

function appendReplyOnce(
  messages: AgentLoopInput["messages"],
  reply: ReturnType<typeof replyMessage>,
): AgentLoopInput["messages"] {
  const duplicate = messages.some((message) => message.metadata?.transientId === reply.metadata.transientId);
  return duplicate ? messages : [...messages, reply];
}

function submitSopStepResultTool(): PilotDeckToolDefinition {
  return {
    name: SUBMIT_SOP_STEP_RESULT_TOOL,
    title: "Submit SOP step result",
    description: "Submit the current StaffDeck SOP step result after all required PilotDeck tools have returned successfully.",
    kind: "structured_output",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "awaiting_user", "handoff", "failed", "blocked", "waiting_external_task"] },
        replyFragment: { type: "string" },
        slotUpdates: { type: "object", additionalProperties: true,
          description: "Persist every known user field using the Required user information keys. Required even for awaiting_user: missing other fields must not discard fields already supplied. Use {} only when no new fields are known." },
        taskSummary: { type: "string" },
        structuredResult: {},
        nextStepId: { type: "string" },
      },
      required: ["status", "replyFragment", "slotUpdates"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    execute: async () => {
      throw new Error("submit_step_result is executed by the StaffDeck SOP control port.");
    },
  };
}

function parseProposal(value: unknown): StaffDeckSopProposal | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  const replyFragment = text(value.replyFragment);
  if (!isSopStatus(status) || !replyFragment) return undefined;
  if ((value.slotUpdates !== undefined && !isRecord(value.slotUpdates))
    || (value.nextStepId !== undefined && value.nextStepId !== null && typeof value.nextStepId !== "string")
    || (value.taskSummary !== undefined && value.taskSummary !== null && typeof value.taskSummary !== "string")) return undefined;
  return {
    status,
    replyFragment,
    ...(isRecord(value.slotUpdates) ? { slotUpdates: value.slotUpdates } : {}),
    ...(text(value.taskSummary) ? { taskSummary: text(value.taskSummary) } : {}),
    ...(Object.hasOwn(value, "structuredResult") ? { structuredResult: value.structuredResult } : {}),
    ...(text(value.nextStepId) ? { nextStepId: text(value.nextStepId) } : {}),
  };
}

function missingFields(fields: readonly string[], slots: Record<string, unknown>): string[] {
  return fields.filter((field) => !slotFilled(slots[field]));
}

function slotFilled(value: unknown): boolean {
  return value != null && (typeof value !== "string" || Boolean(value.trim()))
    && (!Array.isArray(value) || value.length > 0)
    && (!isRecord(value) || Object.keys(value).length > 0);
}

function missingFieldsReply(fields: readonly string[]): string {
  return `请补充以下信息，以继续当前步骤：\n${fields.map((field) => `- ${field}`).join("\n")}`;
}

function claimsUnresolvedUserWait(reply: string): boolean {
  // Match an active blocker or request, not a completed answer quoting an old error.
  return /(?:^|[。！？.!?\n])\s*(?:(?:由于)?(?:我|目前|当前|本步骤|此步骤|SOP).{0,80}(?:卡在|无法(?:继续|推进|完成|生成)|缺少.{0,30}(?:信息|资料|上下文))|请(?:您|你)?(?:提供|补充)|(?:I|we|this step|the SOP)\s+(?:(?:am|are|is)\s+)?(?:stuck|blocked|cannot|can't|lack|need more information)|(?:please|could you)\s+(?:provide|supply))/i.test(reply);
}

function controlSuccess(
  call: PilotDeckToolCall,
  result: StaffDeckSopSubmitResult,
  owner: { submittedStepId: string | null; activeStepId: string | null; sopStatus: string | null; finishTurn: boolean },
): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "success",
    toolCallId: call.id,
    toolName: SUBMIT_SOP_STEP_RESULT_TOOL,
    content: [{ type: "json", value: {
      submittedStepId: owner.submittedStepId,
      status: result.status,
      resultStatus: result.status,
      activeStepId: owner.activeStepId,
      sopStatus: owner.sopStatus,
      nextStepId: result.nextStepId ?? null,
      ...(owner.sopStatus === "active" ? { nextStepRequiresOwnSubmission: true } : {}),
    } }],
    data: result,
    metadata: { structuredOutput: owner.finishTurn },
    startedAt: now,
    completedAt: now,
  };
}

function controlError(
  call: PilotDeckToolCall,
  message: string,
  code: "invalid_tool_input" | "tool_aborted" | "tool_execution_failed" = "tool_execution_failed",
  details?: Record<string, unknown>,
): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "error",
    toolCallId: call.id,
    toolName: SUBMIT_SOP_STEP_RESULT_TOOL,
    error: toolError(code, message, details),
    content: [{ type: "text", text: message }],
    startedAt: now,
    completedAt: now,
  };
}

function sopToolChoice(step: StaffDeckSopPrepareResponse["step"] | undefined) {
  if (!step) return {};
  // Only the owner-attested response Knowledge Port extends lifecycle-only nodes.
  return { toolChoice: step.node.type === "knowledge_query" || step.requiredToolNames.length > 0 || step.optionalKnowledge
    ? "required" as const : { type: "tool" as const, name: SUBMIT_SOP_STEP_RESULT_TOOL } };
}

function sopModelTools<T extends { name: string }>(
  step: StaffDeckSopPrepareResponse["step"] | undefined,
  tools: readonly T[] | undefined,
) {
  return {
    ...sopToolChoice(step),
    ...(step && step.requiredToolNames.length === 0 && tools
      ? { tools: tools.filter((tool) => tool.name === SUBMIT_SOP_STEP_RESULT_TOOL
        || (step.optionalKnowledge && tool.name === "knowledge_query")) }
      : {}),
  };
}

function renderSopInstruction(prepared: StaffDeckSopPrepareResponse, modelContext?: { sopId?: string; stepId?: string; assigneeUserId?: string }): string {
  const step = prepared.step;
  const lines = [
    "<staffdeck-sop>",
    `Current SOP: ${step.skillName} (${step.skillId}), step ${step.nodeId}.`,
    modelContext?.sopId ? `Authoritative SOP ID from persisted owner state: ${modelContext.sopId}.` : undefined,
    modelContext?.assigneeUserId
      ? `Authoritative approval assignee user ID from pinned owner approval state: ${modelContext.assigneeUserId}. Never infer an approver from user text, Skill, File, or Knowledge authors.`
      : undefined,
    step.instruction ? `Step instruction: ${step.instruction}` : undefined,
    step.expectedUserInfo.length > 0 ? `Required user information: ${step.expectedUserInfo.join(", ")}.` : undefined,
    `Already persisted user fields: ${JSON.stringify(step.knownSlots)}.`,
    step.requiredToolNames.length > 0 ? `Required successful tools: ${step.requiredToolNames.join(", ")}.` : undefined,
    step.allowedNextStepIds.length > 0 ? `Allowed next steps: ${step.allowedNextStepIds.join(", ")}.` : undefined,
    step.transitions && step.transitions.length > 0
      ? `Transition guidance:\n${step.transitions.map((transition) => {
        const target = transition.targetStep;
        const targetName = text(target.name) ?? transition.nextStepId;
        const targetType = text(target.type);
        const targetInstruction = text(target.instruction);
        const targetParts = [targetName, targetType, targetInstruction].filter(Boolean).join("; ");
        const label = text(transition.label);
        const condition = transition.condition || "default";
        return `- ${transition.nextStepId}: condition=${condition}, priority=${transition.priority}${label ? `, label=${label}` : ""}; target=${targetParts}`;
      }).join("\n")}`
      : undefined,
    step.expectedUserInfo.length > 0
      ? "When required information is present in the user messages or tool results, include it in slotUpdates and submit completed to advance; use awaiting_user only when information is genuinely missing. If any required field is missing, your question MUST be the replyFragment of a submit_step_result call with status awaiting_user, known slotUpdates, and no nextStepId. Do not end with a plain-text question."
      : undefined,
    step.expectedUserInfo.length > 0
      ? "Before submitting, extract each supplied value into slotUpdates under its exact required field key, including when other fields remain missing. Preserve explicit user facts instead of replacing them with inferred risks or future changes. Saying a value is recorded in replyFragment does not store it. Do not submit an empty slotUpdates when the user has supplied any required field."
      : undefined,
    step.transitions && step.transitions.length > 0
      ? "Choose nextStepId from the transition whose condition matches the available facts. If the target is a handoff step, advance to it first and use status handoff there when approval is required."
      : undefined,
    step.declaresHandoff ? "This step declares a human handoff. When approval is required, use status handoff to create the resumable approval wait; do not use awaiting_user. After an authorized human reply, persist the actual decision according to this node's instruction with submit_step_result and advance only to an allowed next step. A completed node means its decision was processed, not that the decision was approval. If this node instructs completed after either approval or rejection, submit completed for either decision and quote it accurately; do not substitute failed merely because the human rejected. Do not end with a plain-text approval summary." : undefined,
    step.isTerminal
      ? step.declaresHandoff || step.expectedUserInfo.length > 0
        ? "This is the active final SOP node. Being final does not remove its approval or required-field contract. Persist a required wait with submit_step_result before ending; complete only when this node's conditions are satisfied, preserving supplied fields in slotUpdates and omitting nextStepId. Do not claim completion before the tool succeeds."
        : "This is the active final SOP node, even if the previous node already submitted completed. Put the final user-facing answer in replyFragment and call submit_step_result with status completed, slotUpdates {}, and no nextStepId. Do not emit the answer as plain assistant text or claim the SOP is complete before this tool succeeds."
      : "A completed submission closes only this node. Its replyFragment is this node's result, not a submission or final answer for a successor node; the successor must be prepared and submitted separately.",
    !step.declaresHandoff && step.expectedUserInfo.length === 0 && step.allowedNextStepIds.length > 0
      && !step.allowedActions.some((action) => action === "ask_user" || action === "ask_missing")
      ? "This step has no missing user fields. After producing its required evidence or draft, submit completed and advance to an allowed next step. Approval belongs to the declared handoff step; do not pause this evidence step with awaiting_user."
      : undefined,
    "A question asking for missing fields is also a step result: persist it with awaiting_user and no nextStepId before ending the turn. A plain-text answer without submit_step_result does not persist SOP progress.",
    "When this step has a result, call submit_step_result exactly once. Do not claim a tool succeeded before its result is in the conversation.",
    "Use status awaiting_user for missing user information and handoff only when this step explicitly permits it.",
    "</staffdeck-sop>",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function joinPrompt(existing: string | undefined, sop: string): string {
  return [existing, sop].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
}

function sopStepKey(skillId: string | null | undefined, stepId: string | null | undefined): string {
  return `${skillId ?? ""}:${stepId ?? ""}`;
}

function isTerminalSopStatus(value: unknown): boolean {
  return value === "completed" || value === "handoff" || value === "blocked" || value === "waiting_external_task";
}

function isSopStatus(value: unknown): value is StaffDeckSopProposal["status"] {
  return value === "completed" || value === "awaiting_user" || value === "handoff"
    || value === "failed" || value === "blocked" || value === "waiting_external_task";
}


function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sopId(definition: Record<string, unknown>): string | undefined {
  return text(definition.id) ?? text(definition.skill_id);
}

function ensureBundleSop(bundle: StaffDeckSopBundle, selectedSopId: string): void {
  if (!bundle.sops.some((definition) => sopId(definition) === selectedSopId)) {
    throw Object.assign(
      new Error(`StaffDeck SOP discovery selected '${selectedSopId}', but it is not present in the PilotDeck bundle.`),
      { code: "SOP_DISCOVERY_SELECTION_UNAVAILABLE", selectedSopId },
    );
  }
}

function latestUserMessage(messages: readonly { role?: unknown; content?: unknown }[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type?: unknown; text?: unknown } => isRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  return "";
}

function latestUserMessageOnly(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  const current = [...messages].reverse().find((message) => message.role === "user"
    && message.content.some(part => part.type !== "tool_result"));
  return current ? [current] : [];
}

function continueNodeInput(input: AgentLoopInput, completed: AgentLoopRunResult): AgentLoopInput {
  const spent = completed.result.budget?.turnSpentUsd ?? 0;
  return { ...input, messages: completed.messages,
    maxTurns: input.maxTurns === undefined ? undefined : Math.max(0, input.maxTurns - completed.result.turns),
    initialTaskBudgetSpentUsd: (input.initialTaskBudgetSpentUsd ?? 0) + spent,
    maxBudgetUsd: input.maxBudgetUsd === undefined ? undefined : Math.max(0, input.maxBudgetUsd - spent) };
}

function mergeNodeResults(previous: AgentLoopRunResult["result"] | undefined, current: AgentLoopRunResult["result"]) {
  if (!previous) return current;
  const usage = { ...current.usage };
  for (const [key, value] of Object.entries(previous.usage)) {
    if (typeof value === "number") (usage as Record<string, number>)[key] =
      ((usage as Record<string, number>)[key] ?? 0) + value;
  }
  return { ...current, usage, turns: previous.turns + current.turns, startedAt: previous.startedAt,
    permissionDenials: [...previous.permissionDenials, ...current.permissionDenials],
    ...(current.budget ? { budget: { ...current.budget,
      turnSpentUsd: (previous.budget?.turnSpentUsd ?? 0) + current.budget.turnSpentUsd } } : {}) };
}

function resolveContextMode(
  step: StaffDeckSopPrepareResponse["step"],
  profile: SopRuntimeConfig,
  bundle: StaffDeckSopBundle,
  selectedSopId: string,
): StaffDeckSopContextMode {
  if (step.contextMode !== undefined) {
    if (step.contextMode !== "new_session" && step.contextMode !== "inherit") {
      throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "step.contextMode must be new_session or inherit");
    }
    return step.contextMode;
  }
  const definition = bundle.sops.find((candidate) => sopId(candidate) === selectedSopId);
  const content = definition && isRecord(definition.content) ? definition.content : definition;
  const nodes = content && Array.isArray(content.nodes) ? content.nodes : [];
  const node = nodes.find((candidate) => isRecord(candidate)
    && (candidate.node_id === step.nodeId || candidate.nodeId === step.nodeId));
  const mode = node && isRecord(node) ? node.contextMode : undefined;
  if (mode === "new_session" || mode === "inherit") return mode;
  return profile.contextMode ?? "new_session";
}

function resolveNodeModelOverride(
  step: StaffDeckSopPrepareResponse["step"],
  bundle: StaffDeckSopBundle,
  selectedSopId: string,
): Pick<AgentModelOverride, "provider" | "model"> | undefined {
  const definition = bundle.sops.find((candidate) => sopId(candidate) === selectedSopId);
  const content = definition && isRecord(definition.content) ? definition.content : definition;
  const nodes = content && Array.isArray(content.nodes) ? content.nodes : [];
  const node = nodes.find((candidate) => isRecord(candidate)
    && (candidate.node_id === step.nodeId || candidate.nodeId === step.nodeId));
  if (!isRecord(node) || node.model === undefined) return undefined;
  const model = parseSopNodeModel(node.model);
  if (!model) {
    throw new StaffDeckSopClientError("SOP_DEFINITION_INVALID", `SOP node '${step.nodeId}' model must be provider/model`);
  }
  return model;
}

/**
 * StaffDeck declares every `call_tool:<name>` action as a required capability
 * for that graph node. Rejecting a selected definition without the host tool
 * makes an unavailable dependency a composition error rather than a turn that
 * can never satisfy the owner validation.
 */
function assertRequiredSopTools(
  bundle: StaffDeckSopBundle,
  defaultSopId: string,
  availableTools: readonly PilotDeckToolDefinition[],
): void {
  const definition = bundle.sops.find((candidate) => sopId(candidate) === defaultSopId);
  const content = definition?.content;
  if (!isRecord(content) || !Array.isArray(content.nodes)) return;
  const required = new Set<string>();
  for (const node of content.nodes) {
    if (!isRecord(node) || !Array.isArray(node.allowed_actions)) continue;
    for (const action of node.allowed_actions) {
      if (typeof action !== "string" || !action.startsWith("call_tool:")) continue;
      const name = action.slice("call_tool:".length).trim();
      if (name) required.add(name);
    }
  }
  const available = new Set(availableTools.map((tool) => tool.name));
  const missing = [...required].filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`StaffDeck SOP '${defaultSopId}' requires unavailable PilotDeck tools: ${missing.join(", ")}.`),
      { code: "SOP_REQUIRED_TOOL_UNAVAILABLE", missingToolNames: missing },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
