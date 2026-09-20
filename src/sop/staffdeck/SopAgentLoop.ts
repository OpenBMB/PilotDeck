import { join } from "node:path";

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
import type { ModelExecutionContext, ToolPort } from "../../agent/modules/protocol.js";
import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
} from "../../tool/index.js";
import { toolError } from "../../tool/index.js";

import { StaffDeckSopClient, StaffDeckSopClientError } from "./StaffDeckSopClient.js";
import { loadStaffDeckSopDefinitions } from "./StaffDeckSopDefinitions.js";
import { SopStateStore } from "./SopStateStore.js";
import type {
  StaffDeckSopBundle,
  StaffDeckSopPrepareResponse,
  StaffDeckSopProposal,
  StaffDeckSopReplyDelivery,
  StaffDeckSopRuntimeClient,
  SopRuntimeConfig,
  StaffDeckSopSubmitResult,
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
  /** Optional externally deployed loop. SOP remains a host-side decorator. */
  runnerFactory?: AgentLoopRuntimeFactory;
  sidecarModules?: SidecarModuleComposition;
  sidecarTransportContext?: AgentLoopRuntimeFactoryInput["sidecarTransportContext"];
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
  private readonly native: AgentLoopRunner;

  constructor(
    config: AgentRuntimeConfig,
    capabilities: AgentTurnCapabilities,
    seedState: AgentLoopSeedState | undefined,
    private readonly options: SopAgentLoopOptions,
  ) {
    config.stopOnStructuredOutput = true;
    assertRequiredSopTools(options.bundle, options.profile.defaultSopId, capabilities.toolExecution.list());
    this.stateStore = options.stateStore ?? new SopStateStore(join(config.staffDeckSop!.stateRoot, "sessions"));
    this.client = options.client ?? new StaffDeckSopClient(options.profile.endpoint, {
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
    });

    const controlPort = new SopControlToolPort({
      delegate: capabilities.toolExecution,
      client: this.client,
      stateStore: this.stateStore,
      bundle: options.bundle,
      defaultSopId: options.profile.defaultSopId,
      onSubmission: (sessionId, result) => this.submissions.set(sessionId, { result }),
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
      toolExecution,
      contextPreparation,
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
            ? wrapSidecarModules(options.sidecarModules, controlPort, (input) => this.prepareContext(capabilities, input))
            : undefined,
          seedState,
          sidecarTransportContext: options.sidecarTransportContext,
        })
      : new AgentLoop(config, wrappedCapabilities, seedState);
  }

  snapshotFileState(): AgentLoopSeedState {
    return this.native.snapshotFileState();
  }

  seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    return this.native.seedReadState?.(filePath, mtimeMs) ?? Promise.resolve({ applied: false });
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.submissions.delete(input.sessionId);
    const recoverableDelivery = await this.stateStore.replyDelivery(input.sessionId);
    if (recoverableDelivery) {
      return yield* this.deliverReply(input, recoverableDelivery);
    }
    const iterator = this.native.run(input);
    let completed: AgentLoopRunResult;
    let delayedCompletion: Extract<AgentEvent, { type: "turn_completed" }> | undefined;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        completed = next.value;
        break;
      }
      if (next.value.type === "turn_completed" && this.submissions.has(input.sessionId)) {
        delayedCompletion = next.value;
        continue;
      }
      yield next.value;
    }

    const submission = this.submissions.get(input.sessionId);
    if (!submission) return completed;
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
      messages: [...completed.messages, finalMessage],
    };
    if (delayedCompletion) {
      yield { ...delayedCompletion, result: rewritten.result };
    }
    await this.stateStore.clearReplyDelivery(input.sessionId, input.turnId);
    return rewritten;
  }

  private async *deliverReply(
    input: AgentLoopInput,
    delivery: StaffDeckSopReplyDelivery,
  ): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    const finalMessage = replyMessage(delivery.result, input.turnId);
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
    yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
    await this.stateStore.clearReplyDelivery(input.sessionId, input.turnId);
    return { result, messages: appendReplyOnce(input.messages, finalMessage) };
  }

  private async prepareContext(
    capabilities: AgentTurnCapabilities,
    input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0],
  ) {
    const persisted = await this.stateStore.loadOrCreate(
      input.sessionId,
      this.options.bundle,
      this.options.profile.defaultSopId,
    );
    if (isTerminalSopStatus(persisted.state.status)) {
      return capabilities.contextPreparation.prepareForModel(input);
    }
    const prepared = await this.client.prepare({
      bundle: persisted.bundle,
      state: persisted.state,
      context: {
        runId: `sop:${input.sessionId}:${input.turnId}`,
        operationId: `sop.prepare:${input.sessionId}:${input.turnId}`,
        requestId: `sop.prepare:${input.sessionId}:${input.turnId}:${input.stepId ?? 0}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        idempotencyKey: `sop.prepare:${input.sessionId}:${input.turnId}:${input.stepId ?? 0}`,
        expectedRevision: persisted.revision,
      },
      signal: input.abortSignal,
    });
    await this.stateStore.replace(input.sessionId, persisted.bundle, prepared.state);
    return capabilities.contextPreparation.prepareForModel({
      ...input,
      appendSystemPrompt: joinPrompt(input.appendSystemPrompt, renderSopInstruction(prepared)),
    });
  }
}

/** Creates a native PilotDeck loop decorated with one StaffDeck SOP profile. */
export function createStaffDeckSopAgentLoop(
  input: AgentLoopRuntimeFactoryInput,
  profile: SopRuntimeConfig,
  runnerFactory?: AgentLoopRuntimeFactory,
): SopAgentLoop {
  const bundle = loadStaffDeckSopDefinitions(profile.definitionsPath);
  if (!bundle.sops.some((definition) => sopId(definition) === profile.defaultSopId)) {
    throw new Error(`StaffDeck SOP defaultSopId '${profile.defaultSopId}' is not present in ${profile.definitionsPath}.`);
  }
  return new SopAgentLoop(input.config, input.capabilities, input.seedState, {
    profile,
    bundle,
    ...(runnerFactory ? { runnerFactory } : {}),
    ...(input.sidecarModules ? { sidecarModules: input.sidecarModules } : {}),
    ...(input.sidecarTransportContext ? { sidecarTransportContext: input.sidecarTransportContext } : {}),
  });
}

function wrapSidecarModules(
  modules: SidecarModuleComposition,
  controlPort: ToolPort,
  prepareForModel: (input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0]) => ReturnType<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>,
): SidecarModuleComposition {
  return Object.freeze({
    ...modules,
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
  bundle: StaffDeckSopBundle;
  defaultSopId: string;
  onSubmission(sessionId: string, result: StaffDeckSopSubmitResult): void;
}>;

class SopControlToolPort implements ToolPort {
  constructor(private readonly options: SopControlToolPortOptions) {}

  list(): PilotDeckToolDefinition[] {
    const tools = this.options.delegate.list();
    if (tools.some((tool) => tool.name === SUBMIT_SOP_STEP_RESULT_TOOL)) {
      throw new Error(`${SUBMIT_SOP_STEP_RESULT_TOOL} is reserved by the StaffDeck SOP runtime.`);
    }
    return [...tools, submitSopStepResultTool()];
  }

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
    execution: ModelExecutionContext,
  ): Promise<PilotDeckToolResult[]> {
    const controls = calls.filter((call) => call.name === SUBMIT_SOP_STEP_RESULT_TOOL);
    const ordinary = calls.filter((call) => call.name !== SUBMIT_SOP_STEP_RESULT_TOOL);
    const ordinaryResults = ordinary.length > 0
      ? await this.options.delegate.executeAll(ordinary, context, execution)
      : [];
    const resultByCallId = new Map(ordinaryResults.map((result) => [result.toolCallId, result]));

    if (ordinaryResults.some((result) => result.type === "success")) {
      await this.options.stateStore.recordSuccessfulTools(
        execution.sessionId,
        this.options.bundle,
        this.options.defaultSopId,
        ordinaryResults
          .filter((result): result is Extract<PilotDeckToolResult, { type: "success" }> => result.type === "success")
          .map((result) => result.toolName),
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
    const proposal = parseProposal(call.input);
    if (!proposal) return controlError(call, "submit_step_result requires a valid SOP status and non-empty replyFragment.", "invalid_tool_input");
    try {
      const persisted = await this.options.stateStore.loadOrCreate(
        execution.sessionId,
        this.options.bundle,
        this.options.defaultSopId,
      );
      const successfulToolNames = Array.isArray(persisted.state.successful_tool_names)
        ? persisted.state.successful_tool_names.filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
      const submitted = await this.options.client.submit({
        bundle: persisted.bundle,
        state: persisted.state,
        proposal,
        successfulToolNames,
        context: {
          runId: execution.runId,
          operationId: execution.operationId ?? `sop.submit:${execution.sessionId}:${execution.turnId}`,
          requestId: `sop.submit:${call.id}`,
          sessionId: execution.sessionId,
          turnId: execution.turnId,
          idempotencyKey: call.id,
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
      this.options.onSubmission(execution.sessionId, submitted.result);
      return controlSuccess(call, submitted.result);
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
        slotUpdates: { type: "object", additionalProperties: true },
        taskSummary: { type: "string" },
        structuredResult: {},
        nextStepId: { type: "string" },
      },
      required: ["status", "replyFragment"],
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
  return {
    status,
    replyFragment,
    ...(isRecord(value.slotUpdates) ? { slotUpdates: value.slotUpdates } : {}),
    ...(text(value.taskSummary) ? { taskSummary: text(value.taskSummary) } : {}),
    ...(Object.hasOwn(value, "structuredResult") ? { structuredResult: value.structuredResult } : {}),
    ...(text(value.nextStepId) ? { nextStepId: text(value.nextStepId) } : {}),
  };
}

function controlSuccess(call: PilotDeckToolCall, result: StaffDeckSopSubmitResult): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "success",
    toolCallId: call.id,
    toolName: SUBMIT_SOP_STEP_RESULT_TOOL,
    content: [{ type: "json", value: { status: result.status, nextStepId: result.nextStepId ?? null } }],
    data: result,
    metadata: { structuredOutput: true },
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

function renderSopInstruction(prepared: StaffDeckSopPrepareResponse): string {
  const step = prepared.step;
  const lines = [
    "<staffdeck-sop>",
    `Current SOP: ${step.skillName} (${step.skillId}), step ${step.nodeId}.`,
    step.instruction ? `Step instruction: ${step.instruction}` : undefined,
    step.expectedUserInfo.length > 0 ? `Required user information: ${step.expectedUserInfo.join(", ")}.` : undefined,
    step.requiredToolNames.length > 0 ? `Required successful tools: ${step.requiredToolNames.join(", ")}.` : undefined,
    step.allowedNextStepIds.length > 1 ? `Allowed next steps: ${step.allowedNextStepIds.join(", ")}.` : undefined,
    "When this step has a result, call submit_step_result exactly once. Do not claim a tool succeeded before its result is in the conversation.",
    "Use status awaiting_user for missing user information and handoff only when this step explicitly permits it.",
    "</staffdeck-sop>",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function joinPrompt(existing: string | undefined, sop: string): string {
  return [existing, sop].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
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
