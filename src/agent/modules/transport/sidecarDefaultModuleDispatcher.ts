import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../model/index.js";
import type { LifecycleDispatchResult } from "../../../lifecycle/index.js";
import { isPilotDeckHookEvent } from "../../../extension/hooks/protocol/events.js";
import type { PilotDeckToolCall, PilotDeckToolDefinition } from "../../../tool/index.js";
import { HostToolCheckpoint } from "../checkpoint/hostToolCheckpoint.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import { buildTurnEnvironment } from "../../turn/TurnEnvironment.js";
import type {
  ModelExecutionContext,
  ModuleCallRequest,
  PreparedModelInvocation,
} from "../protocol.js";
import type { AgentEvent } from "../../protocol/events.js";
import type {
  SidecarCapabilityResultObserver,
  SidecarModuleHandler,
  SidecarModuleHandlerRegistry,
} from "./agentLoopSidecarClient.js";
import type { SidecarModuleComposition } from "./sidecarHostModulePorts.js";
import {
  finalizePreparedModelRequest,
  normalizeMessagesForModelRequest,
} from "../../loop/modelRequestAssembly.js";
import { COMPACTION_BUDGET_CONTRACT_ERROR_CODE } from "../../../context/index.js";

export type SidecarModuleManifest = Readonly<{
  tools: readonly Record<string, unknown>[];
  permissionContext: Record<string, unknown>;
  hostModules: Record<string, unknown>;
  interactionCapabilities: Readonly<{ elicitationAvailable: boolean }>;
}>;

export function createSidecarDefaultModuleDispatcher(options: {
  config: AgentRuntimeConfig;
  modules: SidecarModuleComposition;
  input: AgentLoopInput;
  checkpoint: HostToolCheckpoint;
  capabilityResultObserver: SidecarCapabilityResultObserver;
  planTodoHandler: SidecarModuleHandler;
}): Readonly<{
  handlers: SidecarModuleHandlerRegistry;
  manifest: SidecarModuleManifest;
  /** Apply steer attachment authority only after the canonical steer message is durable. */
  applySteerAuthorization(itemId: string): void;
  dispose(): Promise<void>;
}> {
  const capabilityContext = options.modules.capability.runtimeContext.bindTurn({
    config: options.config,
    input: options.input,
    checkpoint: options.checkpoint,
  });
  const permissionContext = options.modules.permission?.requestContext.bindTurn({
    config: options.config,
    input: options.input,
    checkpoint: options.checkpoint,
  });
  const contextIdentity = options.modules.context?.requestIdentity.bindTurn({
    config: options.config,
    input: options.input,
    checkpoint: options.checkpoint,
  });
  const preparations = new Map<string, PreparedModelInvocation>();
  const modelStreams = new Map<string, AsyncIterator<CanonicalModelEvent>>();
  const pendingSteerAuthorizations = new Map<string, string[]>();
  const handlers: SidecarModuleHandlerRegistry = Object.freeze({
    model: async (call) => {
      const operation = stringField(call.payload, "operation");
      if (operation === "get_metadata") {
        const metadata = options.modules.model.metadata;
        if (!metadata) throw new Error("Host model metadata capability is unavailable.");
        return {
          metadata: serializeModelMetadata(
            metadata,
            stringField(call.payload, "provider"),
            stringField(call.payload, "model"),
          ),
        };
      }
      const preparationId = stringField(call.payload, "preparationId");
      const context = modelExecutionContext(call, options.input, options.input.abortSignal);
      if (operation === "prepare") {
        const prepared = await options.modules.model.execution.prepare({ request: canonicalModelRequest(call.payload.request), context });
        preparations.set(preparationId, prepared);
        return {
          prepared: serializablePreparedInvocation(prepared),
          ...(options.modules.model.metadata
            ? { metadata: serializeModelMetadata(options.modules.model.metadata, prepared.provider, prepared.model) }
            : {}),
        };
      }
      if (operation === "materialize_prepared_request") {
        const prepared = preparations.get(preparationId);
        if (!prepared) throw new Error(`Unknown sidecar model preparation: ${preparationId}`);
        const candidate = canonicalModelRequest(call.payload.request);
        const request = options.modules.model.materializeRequest
          ? await options.modules.model.materializeRequest(prepared, candidate)
          : {
              ...prepared.request,
              messages: candidate.messages,
              provider: prepared.provider,
              model: prepared.model,
            };
        return { request: canonicalModelRequest(request) };
      }
      if (operation === "stream") {
        const prepared = preparations.get(preparationId);
        if (!prepared) throw new Error(`Unknown sidecar model preparation: ${preparationId}`);
        const events: CanonicalModelEvent[] = [];
        const currentPrepared = {
          ...prepared,
          request: call.payload.request === undefined
            ? prepared.request
            : canonicalModelRequest(call.payload.request),
        };
        for await (const event of options.modules.model.execution.stream({ prepared: currentPrepared, context })) events.push(event);
        return { events };
      }
      if (operation === "stream_next") {
        let iterator = modelStreams.get(preparationId);
        if (!iterator) {
          const prepared = preparations.get(preparationId);
          if (!prepared) throw new Error(`Unknown sidecar model preparation: ${preparationId}`);
          const currentPrepared = { ...prepared, request: canonicalModelRequest(call.payload.request) };
          iterator = options.modules.model.execution.stream({ prepared: currentPrepared, context })[Symbol.asyncIterator]();
          modelStreams.set(preparationId, iterator);
        }
        try {
          const next = await iterator.next();
          if (next.done) {
            modelStreams.delete(preparationId);
            preparations.delete(preparationId);
            return { events: [], done: true };
          }
          return { events: [next.value], done: false };
        } catch (error) {
          modelStreams.delete(preparationId);
          preparations.delete(preparationId);
          throw error;
        }
      }
      if (operation === "close_stream") {
        const iterator = modelStreams.get(preparationId);
        modelStreams.delete(preparationId);
        preparations.delete(preparationId);
        await iterator?.return?.();
        return { closed: true };
      }
      throw new Error(`Unsupported sidecar model operation: ${operation}`);
    },
    ...(options.modules.budget ? { budget: async (call: ModuleCallRequest) => dispatchBudget(options, call) } : {}),
    turn: async (call: ModuleCallRequest) => dispatchTurn(options.input, call, pendingSteerAuthorizations),
    capability: async (call) => {
      const operation = stringField(call.payload, "operation");
      if (operation === "plan_todo") return options.planTodoHandler(call);
      if (operation === "list_tools") {
        await options.modules.capability.execution.refresh?.();
        return { tools: options.modules.capability.execution.list().map(serializeToolDescriptor) };
      }
      const planTodo = options.modules.planTodo?.forSession(options.input.sessionId);
      const context = capabilityContext.toolRuntimeContext(call.payload.context, planTodo, true);
      const execution = capabilityContext.executionContext(call);
      if (operation === "execute_batch") {
        const calls = Array.isArray(call.payload.calls)
          ? call.payload.calls.map(parseToolCall)
          : (() => { throw new Error("Capability batch call must contain calls."); })();
        const results = await options.modules.capability.execution.executeAll(calls, context, execution);
        if (results.length !== calls.length) throw new Error("Capability port returned an incomplete batch result.");
        await options.capabilityResultObserver.onCapabilityResults(results);
        return { results };
      }
      if (operation === "execute") {
        const tool = parseToolCall({ toolCallId: call.payload.toolCallId, name: call.payload.name, arguments: call.payload.arguments });
        const [result] = await options.modules.capability.execution.executeAll([tool], context, execution);
        if (!result) throw new Error("Capability port returned no result.");
        await options.capabilityResultObserver.onCapabilityResults([result]);
        return result as unknown as Record<string, unknown>;
      }
      throw new Error(`Unsupported sidecar capability operation: ${operation}`);
    },
    ...(options.modules.permission ? { permission: async (call: ModuleCallRequest) => {
      if (stringField(call.payload, "operation") !== "decide") throw new Error("Unsupported sidecar permission operation.");
      const permission = options.modules.permission!;
      const toolName = stringField(asRecord(call.payload.tool), "name");
      const tool = permission.catalog.list().find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`Permission request references unavailable tool: ${toolName}`);
      const decision = await permission.decision.decide(tool, call.payload.input, permissionContext!.toolRuntimeContext(call.payload.context), stringField(call.payload, "toolCallId"));
      return { decision };
    } } : {}),
    ...(options.modules.context ? { context: async (call: ModuleCallRequest) => dispatchContext(
      options,
      contextIdentity!.contextIdentity(asRecord(call.payload.input)),
      call,
      preparations,
    ) } : {}),
    ...(options.modules.lifecycle ? { lifecycle: async (call: ModuleCallRequest) => dispatchLifecycle(options, call) } : {}),
    ...(options.modules.event ? { event: async (call: ModuleCallRequest) => {
      if (stringField(call.payload, "operation") !== "emit") throw new Error("Unsupported sidecar event operation.");
      options.modules.event!.emit(readHostEmittedEvent(call.payload.event, options.input));
      return { result: null };
    } } : {}),
  });
  return Object.freeze({
    handlers,
    applySteerAuthorization(itemId) {
      const allowedReadFiles = pendingSteerAuthorizations.get(itemId);
      pendingSteerAuthorizations.delete(itemId);
      options.checkpoint.allowReadFiles(allowedReadFiles);
    },
    async dispose() {
      const iterators = [...modelStreams.values()];
      modelStreams.clear();
      preparations.clear();
      await Promise.allSettled(iterators.map((iterator) => iterator.return?.()));
    },
    manifest: Object.freeze({
      tools: options.modules.capability.execution.list().map(serializeToolDescriptor),
      permissionContext: capabilityContext.permissionContext() as unknown as Record<string, unknown>,
      hostModules: hostModuleCapabilities(options.modules, options.input),
      interactionCapabilities: Object.freeze({
        elicitationAvailable: options.modules.interaction?.elicitationAvailable === true,
      }),
    }),
  });
}

async function dispatchBudget(
  options: Parameters<typeof createSidecarDefaultModuleDispatcher>[0],
  call: ModuleCallRequest,
): Promise<Record<string, unknown>> {
  const operation = stringField(call.payload, "operation");
  const budget = options.modules.budget;
  if (!budget) throw new Error("Host budget capability is unavailable.");
  if (operation === "estimate_request_input" && budget.estimateRequestInput) {
    const request = canonicalModelRequest(call.payload.request);
    return { tokens: await budget.estimateRequestInput(request) };
  }
  if (operation === "evaluate_request_budget" && budget.evaluateRequestBudget) {
    const request = canonicalModelRequest(call.payload.request);
    const rawOptions = asRecord(call.payload.options);
    const maxContextTokens = positiveFinite(rawOptions?.maxContextTokens, "maxContextTokens");
    const reservedOutputTokens = optionalNonNegativeFinite(rawOptions?.reservedOutputTokens, "reservedOutputTokens");
    return {
      snapshot: await budget.evaluateRequestBudget(request, {
        maxContextTokens,
        ...(reservedOutputTokens !== undefined ? { reservedOutputTokens } : {}),
        ...(rawOptions?.useProviderCount !== undefined
          ? { useProviderCount: booleanField(rawOptions, "useProviderCount") }
          : {}),
        ...(asRecord(rawOptions?.calibration) ? { calibration: rawOptions!.calibration as never } : {}),
        ...(options.input.abortSignal ? { signal: options.input.abortSignal } : {}),
      }),
    };
  }
  if (operation === "estimate_usage_cost" && budget.estimateUsageCost) {
    const costUsd = await budget.estimateUsageCost(
      asRecord(call.payload.usage) as never,
      stringField(call.payload, "provider"),
      stringField(call.payload, "model"),
    );
    if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0)) {
      throw new Error("Host budget capability returned an invalid usage cost.");
    }
    return { costUsd: costUsd ?? null };
  }
  throw new Error(`Host budget capability does not support ${operation}.`);
}

async function dispatchTurn(
  input: AgentLoopInput,
  call: ModuleCallRequest,
  pendingSteerAuthorizations?: Map<string, string[]>,
): Promise<Record<string, unknown>> {
  const operation = stringField(call.payload, "operation");
  if (operation === "drain_steer" && input.drainSteerMessages) {
    const messages = await input.drainSteerMessages();
    rememberSteerAuthorizations(messages, pendingSteerAuthorizations);
    return { messages };
  }
  if (operation === "drain_or_close_steer" && input.drainOrCloseSteerMailbox) {
    const result = await input.drainOrCloseSteerMailbox();
    rememberSteerAuthorizations(result.messages, pendingSteerAuthorizations);
    return result;
  }
  if (operation === "persist_compaction" && input.onCompactPersisted) {
    const boundary = asRecord(call.payload.boundary);
    const messages = call.payload.messages;
    if (!boundary || !Array.isArray(messages)) {
      throw new Error("Compaction persistence requires boundary and messages.");
    }
    await input.onCompactPersisted({ boundary: boundary as never, messages: messages as never });
    return { persisted: true };
  }
  throw new Error(`Host turn capability does not support ${operation}.`);
}

function rememberSteerAuthorizations(
  messages: readonly import("../../session/SteerMailbox.js").AgentSteerMessage[],
  pending: Map<string, string[]> | undefined,
): void {
  if (!pending) return;
  for (const message of messages) {
    const allowedReadFiles = message.allowedReadFiles?.filter((path) => typeof path === "string") ?? [];
    if (allowedReadFiles.length > 0) pending.set(message.itemId, allowedReadFiles);
  }
}

async function dispatchContext(
  options: Parameters<typeof createSidecarDefaultModuleDispatcher>[0],
  input: Record<string, unknown>,
  call: ModuleCallRequest,
  preparations: ReadonlyMap<string, PreparedModelInvocation>,
): Promise<Record<string, unknown>> {
  const operation = stringField(call.payload, "operation");
  if (operation === "try_auto_compact" && input.budgetStage === undefined) {
    const stage = asRecord(input.budgetProjection)?.stage;
    if (stage === "pre_route" || stage === "routed" || stage === "recovery") {
      input.budgetStage = stage;
    }
  }
  if (operation === "try_auto_compact" && input.maxContextTokens === undefined && options.config.maxContextTokens !== undefined) input.maxContextTokens = options.config.maxContextTokens;
  if (operation === "try_auto_compact" && input.budgetRequest !== undefined) {
    const request = asCompactionContract(() => canonicalModelRequest(input.budgetRequest));
    const budget = options.modules.budget;
    if (budget?.evaluateRequestBudget) {
      const maxContextTokens = asCompactionContract(() => positiveFinite(input.maxContextTokens, "maxContextTokens"));
      const reservedOutputTokens = asCompactionContract(() => optionalNonNegativeFinite(input.reservedOutputTokens, "reservedOutputTokens"));
      const preparation = budgetPreparation(input.budgetPreparation);
      const preparationId = asCompactionContract(() => optionalStringField(input, "budgetPreparationId"));
      const prepared = preparationId ? preparations.get(preparationId) : undefined;
      if (preparationId && !prepared) {
        throw compactionContractError(`Unknown sidecar compaction budget preparation: ${preparationId}`);
      }
      if (prepared && (prepared.provider !== request.provider || prepared.model !== request.model)) {
        throw compactionContractError("Sidecar compaction budget preparation does not match the request route.");
      }
      if (options.modules.model.materializeRequest && input.budgetStage !== "pre_route" && !prepared) {
        throw compactionContractError("Sidecar compaction budget is missing its prepared request reference.");
      }
      const calibration = asCompactionContract(() => budgetCalibration(
        input.budgetCalibration,
        request.provider,
        request.model,
      ));
      input.budgetEvaluator = async (messages: unknown) => {
        const candidateMessages = asCompactionContract(() => canonicalMessages(messages, "Compaction budget messages"));
        const snapshot = await budget.evaluateRequestBudget!(await createCompactionBudgetRequest({
          request,
          preparation,
          candidateMessages,
          config: options.config,
          context: options.modules.context?.execution,
          stage: input.budgetStage as "pre_route" | "routed" | "recovery" | undefined,
          prepared,
          materializeRequest: options.modules.model.materializeRequest,
          signal: options.input.abortSignal,
        }), {
          maxContextTokens,
          ...(reservedOutputTokens !== undefined ? { reservedOutputTokens } : {}),
          ...(options.input.abortSignal ? { signal: options.input.abortSignal } : {}),
          ...(calibration ? { calibration } : {}),
        });
        asCompactionContract(() => validateBudgetSnapshot(snapshot));
        return snapshot;
      };
    }
    delete input.budgetRequest;
  }
  const context = options.modules.context?.execution;
  if (operation === "prepare_for_model" && context) return { result: await context.prepareForModel(input as never) };
  if (operation === "apply_tool_results" && context?.applyToolResults) return { result: await context.applyToolResults(input as never) };
  if (operation === "recover_from_model_error" && context?.recoverFromModelError) return { result: await context.recoverFromModelError(input as never) };
  if (operation === "capture_turn" && context?.captureTurn) { await context.captureTurn(input as never); return { result: null }; }
  if (operation === "try_auto_compact" && context?.tryAutoCompact) return { result: await context.tryAutoCompact(input as never) };
  throw new Error(`Host context capability does not support ${operation}.`);
}

async function dispatchLifecycle(options: Parameters<typeof createSidecarDefaultModuleDispatcher>[0], call: ModuleCallRequest): Promise<Record<string, unknown>> {
  if (stringField(call.payload, "operation") !== "dispatch") throw new Error("Unsupported sidecar lifecycle operation.");
  const event = stringField(call.payload, "event");
  if (!isPilotDeckHookEvent(event)) throw new Error(`Unsupported sidecar lifecycle event: ${event}`);
  const payload = call.payload.payload === undefined ? undefined : asRecord(call.payload.payload) ?? (() => { throw new Error("Lifecycle payload must be an object."); })();
  const result = await options.modules.lifecycle!.dispatch({
    event,
    baseInput: { sessionId: options.input.sessionId, transcriptPath: "", cwd: options.config.cwd, permissionMode: options.config.permissionMode },
    ...(payload ? { payload } : {}),
    matchQuery: event,
    ...(options.input.abortSignal ? { signal: options.input.abortSignal } : {}),
    env: buildTurnEnvironment(options.config.env, options.config.cwd, options.input.sessionId, options.input.turnId),
  });
  return { result: serializeLifecycleDispatchResult(result) };
}

function hostModuleCapabilities(modules: SidecarModuleComposition, input: AgentLoopInput): Record<string, unknown> {
  const context = modules.context?.execution;
  const contextMethods = context ? ["prepare_for_model", ...(context.applyToolResults ? ["apply_tool_results"] : []), ...(context.recoverFromModelError ? ["recover_from_model_error"] : []), ...(context.captureTurn ? ["capture_turn"] : []), ...(context.tryAutoCompact ? ["try_auto_compact"] : [])] : [];
  return {
    model: {
      methods: [
        "prepare",
        ...(modules.model.materializeRequest ? ["materialize_prepared_request"] : []),
        "stream",
        "stream_next",
        "close_stream",
        ...(modules.model.metadata ? ["get_metadata"] : []),
      ],
    },
    ...(modules.budget ? {
      budget: {
        methods: [
          ...(modules.budget.estimateRequestInput ? ["estimate_request_input"] : []),
          ...(modules.budget.evaluateRequestBudget ? ["evaluate_request_budget"] : []),
          ...(modules.budget.estimateUsageCost ? ["estimate_usage_cost"] : []),
        ],
      },
    } : {}),
    ...(
      input.drainSteerMessages || input.drainOrCloseSteerMailbox || input.onCompactPersisted
        ? {
            turn: {
              methods: [
                ...(input.drainSteerMessages ? ["drain_steer"] : []),
                ...(input.drainOrCloseSteerMailbox ? ["drain_or_close_steer"] : []),
                ...(input.onCompactPersisted ? ["persist_compaction"] : []),
              ],
            },
          }
        : {}
    ),
    capability: {
      methods: ["execute", "execute_batch", "list_tools", ...(modules.planTodo ? ["plan_todo"] : [])],
    },
    ...(contextMethods.length > 0 ? { context: { methods: contextMethods } } : {}),
    ...(modules.permission ? { permission: { methods: ["decide"] } } : {}),
    ...(modules.lifecycle ? { lifecycle: { methods: ["dispatch"] } } : {}),
    ...(modules.event ? { event: { methods: ["emit"] } } : {}),
  };
}

function serializeToolDescriptor(tool: PilotDeckToolDefinition): Record<string, unknown> { return { name: tool.name, description: tool.description, kind: tool.kind, inputSchema: tool.inputSchema, readOnly: safely(() => tool.isReadOnly({}), false), concurrencySafe: safely(() => tool.isConcurrencySafe({}), false), requiresUserInteraction: safely(() => tool.requiresUserInteraction?.({}) ?? false, false), ...(tool.requiredRuntimeCapabilities ? { requiredRuntimeCapabilities: [...tool.requiredRuntimeCapabilities] } : {}) }; }
function modelExecutionContext(call: ModuleCallRequest, input: AgentLoopInput, abortSignal?: AbortSignal): ModelExecutionContext { const remote = asRecord(call.payload.context); return { sessionId: input.sessionId, turnId: input.turnId, runId: call.runId, operationId: call.operationId, ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}), ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.storageConfigVersion ? { storageConfigVersion: input.storageConfigVersion } : {}), ...(input.invocationLogSink ? { invocationLogSink: input.invocationLogSink } : {}), ...(abortSignal ? { abortSignal } : {}), ...(modelOverride(remote?.modelOverride) ? { modelOverride: modelOverride(remote?.modelOverride) } : {}), ...(asRecord(remote?.metadata) ? { metadata: asRecord(remote?.metadata) } : {}) }; }
function parseToolCall(value: unknown): PilotDeckToolCall { const record = asRecord(value); return { id: stringField(record, "toolCallId"), name: stringField(record, "name"), input: record?.arguments ?? {} }; }
function canonicalModelRequest(value: unknown): CanonicalModelRequest { const request = asRecord(value); if (!request || typeof request.provider !== "string" || typeof request.model !== "string" || !Array.isArray(request.messages)) throw new Error("Sidecar model call contains an invalid canonical request."); return request as unknown as CanonicalModelRequest; }
function serializablePreparedInvocation(prepared: PreparedModelInvocation): Record<string, unknown> { return { request: prepared.request, provider: prepared.provider, model: prepared.model, ...(prepared.maxContextTokens ? { maxContextTokens: prepared.maxContextTokens } : {}), ...(prepared.maxOutputTokens ? { maxOutputTokens: prepared.maxOutputTokens } : {}) }; }
function serializeModelMetadata(metadata: NonNullable<SidecarModuleComposition["model"]["metadata"]>, provider: string, model: string): Record<string, unknown> {
  const maxContextTokens = metadata.getModelMaxContextTokens?.(provider, model);
  const maxOutputTokens = metadata.getModelMaxOutputTokens?.(provider, model);
  const tokenLimits = metadata.getModelTokenLimits?.(provider, model);
  const protocol = metadata.getModelProtocol?.(provider);
  const supportsPromptCache = metadata.getModelSupportsPromptCache?.(provider, model);
  validateMetadataNumber(maxContextTokens, "maxContextTokens");
  validateMetadataNumber(maxOutputTokens, "maxOutputTokens");
  if (tokenLimits) {
    validateMetadataNumber(tokenLimits.maxContextTokens, "tokenLimits.maxContextTokens");
    validateMetadataNumber(tokenLimits.maxOutputTokens, "tokenLimits.maxOutputTokens");
  }
  if (protocol !== undefined && protocol !== "anthropic" && protocol !== "openai" && protocol !== "openai-responses" && protocol !== "google") {
    throw new Error("Host model metadata returned an invalid protocol.");
  }
  return {
    provider,
    model,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(tokenLimits ? { tokenLimits } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(supportsPromptCache !== undefined ? { supportsPromptCache } : {}),
  };
}
function validateMetadataNumber(value: unknown, field: string): void { if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) throw new Error(`Host model metadata returned an invalid ${field}.`); }
function readHostEmittedEvent(value: unknown, input: AgentLoopInput): AgentEvent { const event = asRecord(value); if (!event || typeof event.type !== "string" || event.sessionId !== input.sessionId || ("turnId" in event && event.turnId !== input.turnId)) throw new Error("Sidecar host event does not match the active turn."); return event as unknown as AgentEvent; }
function serializeLifecycleDispatchResult(result: LifecycleDispatchResult): Record<string, unknown> { return { effects: result.effects, messages: result.messages, events: result.events, blockingErrors: result.blockingErrors, nonBlockingErrors: result.nonBlockingErrors, ...(result.pendingAsyncHooks ? { pendingAsyncHooks: result.pendingAsyncHooks } : {}) }; }
function modelOverride(value: unknown): { provider: string; model: string } | undefined { const record = asRecord(value); return record && typeof record.provider === "string" && typeof record.model === "string" ? { provider: record.provider, model: record.model } : undefined; }
function stringField(value: Record<string, unknown> | undefined, field: string): string { const candidate = value?.[field]; if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`Sidecar payload field ${field} must be a non-empty string.`); return candidate; }
function optionalStringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Sidecar payload field ${field} must be a non-empty string.`);
  }
  return candidate;
}
function booleanField(value: Record<string, unknown> | undefined, field: string): boolean { const candidate = value?.[field]; if (typeof candidate !== "boolean") throw new Error(`Sidecar payload field ${field} must be a boolean.`); return candidate; }
function positiveFinite(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Sidecar payload field ${field} must be positive.`); return value; }
function optionalNonNegativeFinite(value: unknown, field: string): number | undefined { if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Sidecar payload field ${field} must be non-negative.`); return value; }
function validateBudgetSnapshot(value: unknown): void {
  const snapshot = asRecord(value);
  if (!snapshot) throw new Error("Host compaction budget capability returned an invalid snapshot.");
  for (const field of ["tokens", "maxContextTokens", "warningRatio", "blockingRatio", "ratio"]) {
    optionalNonNegativeFinite(snapshot[field], field);
    if (snapshot[field] === undefined) throw new Error(`Host compaction budget snapshot is missing ${field}.`);
  }
  if (snapshot.state !== "ok" && snapshot.state !== "warning" && snapshot.state !== "blocking") {
    throw new Error("Host compaction budget snapshot has an invalid state.");
  }
}

function compactionContractError(message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string };
  error.code = COMPACTION_BUDGET_CONTRACT_ERROR_CODE;
  return error;
}

function asCompactionContract<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (typeof error === "object" && error !== null
      && (error as { code?: unknown }).code === COMPACTION_BUDGET_CONTRACT_ERROR_CODE) {
      throw error;
    }
    throw compactionContractError(error instanceof Error ? error.message : String(error), error);
  }
}
function canonicalMessages(value: unknown, label: string): CanonicalModelRequest["messages"] {
  if (!Array.isArray(value) || value.some((message) => {
    const record = asRecord(message);
    return !record || (record.role !== "user" && record.role !== "assistant") || !Array.isArray(record.content);
  })) {
    throw new Error(`${label} must be canonical messages.`);
  }
  return value as CanonicalModelRequest["messages"];
}
function budgetPreparation(value: unknown): Record<string, unknown> {
  const preparation = asRecord(value);
  if (!preparation || !Array.isArray(preparation.tools) || typeof preparation.provider !== "string" || typeof preparation.model !== "string") {
    throw compactionContractError("Sidecar compaction budget preparation is missing or invalid.");
  }
  return preparation;
}
function budgetCalibration(value: unknown, provider: string, model: string): {
  provider: string; model: string; actualInputTokens: number; estimatedInputTokens: number;
} | undefined {
  if (value === undefined) return undefined;
  const calibration = asRecord(value);
  if (!calibration || calibration.provider !== provider || calibration.model !== model) {
    throw compactionContractError("Sidecar compaction budget calibration does not match the request route.");
  }
  const actualInputTokens = positiveFinite(calibration.actualInputTokens, "calibration.actualInputTokens");
  const estimatedInputTokens = positiveFinite(calibration.estimatedInputTokens, "calibration.estimatedInputTokens");
  return { provider, model, actualInputTokens, estimatedInputTokens };
}

async function createCompactionBudgetRequest(input: {
  request: CanonicalModelRequest;
  preparation: Record<string, unknown>;
  candidateMessages: CanonicalModelRequest["messages"];
  config: AgentRuntimeConfig;
  context: NonNullable<SidecarModuleComposition["context"]>["execution"] | undefined;
  stage?: "pre_route" | "routed" | "recovery";
  prepared?: PreparedModelInvocation;
  materializeRequest?: SidecarModuleComposition["model"]["materializeRequest"];
  signal?: AbortSignal;
}): Promise<CanonicalModelRequest> {
  if (!input.context) throw new Error("Host context capability is unavailable for request-level compaction budgeting.");
  const prepared = await input.context.prepareForModel({
    ...input.preparation,
    messages: normalizeMessagesForModelRequest(input.candidateMessages),
    previewOnly: true,
    ...(input.signal ? { abortSignal: input.signal } : {}),
  } as never);
  // Context preparation is required for the candidate. Do not call model
  // prepare here: that would rerun routing after the stream route is fixed.
  const candidate = (await finalizePreparedModelRequest({
    request: input.request,
    prepared,
    permissionMode: input.config.permissionMode,
    fallbackSystemPrompt: input.request.systemPrompt,
  })).request;
  if (input.prepared && input.materializeRequest) {
    return canonicalModelRequest(await input.materializeRequest(input.prepared, candidate));
  }
  if (input.stage === "routed" || input.stage === "recovery") {
    return canonicalModelRequest({
      ...input.request,
      messages: candidate.messages,
      cacheBreakpoints: candidate.cacheBreakpoints,
      cachePlan: candidate.cachePlan,
    });
  }
  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function safely(value: () => boolean, fallback: boolean): boolean { try { return value(); } catch { return fallback; } }
