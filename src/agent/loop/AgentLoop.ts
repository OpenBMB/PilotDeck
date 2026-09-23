import { TurnTimeline } from "../stream/TurnTimeline.js";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  cloneMessages,
  createModelMessageAssemblerState,
  getModelStreamBlockId,
  messageContent,
  type CanonicalToolCall,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  type CanonicalMessage,
  type CanonicalModelError,
  ModelProviderError,
  snapshotCanonicalModelRequest,
  type CanonicalModelRequest,
  type CanonicalToolSchema,
  type CanonicalUsage,
} from "../../model/index.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckReadFileStateMap,
  PilotDeckToolErrorResult,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
  PilotDeckWriteSnapshotMap,
} from "../../tool/index.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentContextPrepareInput } from "../../context/ContextRuntime.js";
import type { LifecycleDispatchResult } from "../../lifecycle/index.js";
import type { PilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import { truncateHeadPreservingCheckpoint } from "../../context/compaction/CompactionEngine.js";
import type {
  CompactionResult,
  CompactionBudgetEvaluator,
  ContextRecoveryDecision,
  ContextSupplementalToolResultMessage,
  TokenCalibrationBaseline,
  TokenBudgetSnapshot,
} from "../../context/index.js";
import {
  actualInputTokensFromUsage,
  COMPACTION_BUDGET_CONTRACT_ERROR_CODE,
  countTokens,
} from "../../context/index.js";
import type { PermissionMode, PermissionRule, PermissionRuleSet } from "../../permission/index.js";
import type { AgentControlBoundaryTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { AgentSteerMessage } from "../session/SteerMailbox.js";
import { collectToolCalls } from "./collectToolCalls.js";
import { buildTurnEnvironment } from "../turn/TurnEnvironment.js";
import { applyAgentPermissionOverrides } from "../turn/permissionOverrides.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import { LargeFileRepair, type LargeFileRepairDecision } from "./LargeFileRepair.js";
import { resolveOutputTokenRetryBump } from "./outputTokenRetry.js";
import { projectToolResults } from "./projectToolResults.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";
import type { AgentRunMode } from "../protocol/input.js";
import type { AgentExecutionContext, ModelInvokerPort, PreparedModelInvocation, ToolPort } from "../modules/protocol.js";
import {
  isAgentTurnCapabilities,
  type AgentTurnContextPort,
  type AgentTurnCapabilities,
} from "./AgentTurnCapabilities.js";
import {
  createAgentTurnCapabilities,
  type AgentTurnCapabilityComposition,
} from "./nativeAgentTurnCapabilitiesAdapter.js";
import {
  ASK_MODE_DESCRIPTION_SUFFIX,
  isAskModeAllowedTool,
} from "../../tool/askModeConstraints.js";
import { buildAskModeAgentToolSchema } from "../../tool/builtin/agent.js";
import { requestFingerprint } from "../../model/streaming/requestFingerprint.js";
import { seedAgentReadState } from "./seedReadState.js";
import {
  finalizePreparedModelRequest,
  normalizeMessagesForModelRequest,
} from "./modelRequestAssembly.js";
import {
  createAgentStatusDetail,
  createVisibleErrorStatusDetail,
  type AgentStatusI18nDescriptor,
} from "../../status/agentStatus.js";

const TOOL_EVENT_PUMP_INTERVAL_MS = 500;
const SUBAGENT_STATUS_HEARTBEAT_MS = 2_000;
const EMPTY_LENGTH_OUTPUT_RETRY_FLOOR = 4_096;
const CIRCUIT_BREAKER_GRACE_PROMPT = [
  "Your last several tool calls all failed input validation with the same error.",
  "This may indicate a tool-side issue rather than a problem with your approach.",
  "Options: (1) try a different tool or different parameters,",
  "(2) explain the situation in text without calling tools,",
  "(3) if you believe the tool should work, try once more with corrected input.",
].join(" ");
function logAutoCompactFailure(
  stage: string,
  input: { sessionId: string; turnId: string },
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[agent:auto-compact] ${stage} failed sessionId=${input.sessionId} turnId=${input.turnId}: ${message}`,
  );
}

/** Persistence is durable state, unlike a best-effort compaction estimate. */
class CompactionPersistenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CompactionPersistenceError";
  }
}

function isCompactionPersistenceError(error: unknown): error is CompactionPersistenceError {
  return error instanceof CompactionPersistenceError;
}

function isFatalCompactionError(error: unknown): boolean {
  return isCompactionPersistenceError(error)
    || (typeof error === "object" && error !== null
      && (error as { code?: unknown }).code === COMPACTION_BUDGET_CONTRACT_ERROR_CODE);
}

type ActiveSubagentStatus = {
  subagentId: string;
  subagentType?: string;
  startedAtMs: number;
  lastHeartbeatMs: number;
  currentToolCallId?: string;
  currentToolName?: string;
};

type AgentStatusMessage = {
  event: string;
  kind: "status" | "error";
  text: string;
  detail?: Record<string, unknown>;
};

export type AgentLoopInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  maxTurns?: number;
  /** Gateway-owned USD ceiling for this submitted turn. */
  maxBudgetUsd?: number;
  /** Gateway-owned USD ceiling shared by every turn in an SDK session. */
  taskBudgetUsd?: number;
  /** Amount already charged to `taskBudgetUsd` before this turn. */
  initialTaskBudgetSpentUsd?: number;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  /** SDK-only opt-in for native elicitation when permission prompts stay disabled. */
  canElicit?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  modelOverride?: import("../protocol/input.js").AgentModelOverride;
  abortSignal?: AbortSignal;
  onDurableMessage?: (message: CanonicalMessage) => void | Promise<void>;
  onAgentStatusMessage?: (status: AgentStatusMessage) => void | Promise<void>;
  onCompactPersisted?: (input: {
    boundary: AgentControlBoundaryTranscriptEntry["boundary"];
    messages: CanonicalMessage[];
  }) => void | Promise<void>;
  /** Host-owned execution identity. Gateway supplies runId; direct callers may omit it. */
  execution?: Pick<AgentExecutionContext, "runId" | "operationId" | "idempotencyKey" | "operationDeadline">;
  workspaceId?: string;
  storageConfigVersion?: string;
  invocationLogSink?: import("../../storage/legalDataStorage.js").ModelInvocationLogSink;
  /** Drain user guidance that should join this active turn before the next model request. */
  drainSteerMessages?: () => AgentSteerMessage[] | Promise<AgentSteerMessage[]>;
  /** Atomically drain pending guidance or close the inbox before terminal completion. */
  drainOrCloseSteerMailbox?: () =>
    | { messages: AgentSteerMessage[]; closed: boolean }
    | Promise<{ messages: AgentSteerMessage[]; closed: boolean }>;
  /** Acknowledge guidance only after its canonical user message is durable. */
  onSteerApplied?: (itemId: string) => void;
};

export type AgentLoopRunResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type AgentLoopSeedState = {
  readFileState?: PilotDeckReadFileStateMap;
  writeSnapshots?: PilotDeckWriteSnapshotMap;
  allowedReadFiles?: string[];
};

type AgentLoopTokenCap = {
  maxContextTokens?: number;
  /** Session-scoped recovery target, retained across sidecar child turns. */
  sessionMaxOutputTokens?: number;
  requestedMaxOutputTokens?: number;
  attemptMaxOutputTokens?: number;
  hardMaxOutputTokens?: number;
};

/**
 * Volatile, session-owned model state. It is deliberately separate from the
 * durable file checkpoint: a sidecar runner may carry it between child
 * executions, while session recovery starts from the normal conservative
 * baseline.
 */
export type AgentLoopModelSessionState = {
  tokenCalibration?: TokenCalibrationBaseline[];
  tokenCaps?: Array<{
    provider: string;
    model: string;
    maxContextTokens?: number;
    sessionMaxOutputTokens?: number;
    hardMaxOutputTokens?: number;
  }>;
};

export class AgentLoop {
  private readonly readFileState: PilotDeckReadFileStateMap;
  private readonly writeSnapshots: PilotDeckWriteSnapshotMap;
  private readonly allowedReadFiles: Set<string>;
  private readonly tokenCalibrationByRoute = new Map<string, TokenCalibrationBaseline>();
  private readonly transientTokenCaps = new Map<string, AgentLoopTokenCap>();
  private readonly capabilities: AgentTurnCapabilities;
  private readonly modelPort: ModelInvokerPort;
  private readonly toolPort: ToolPort;
  /** Populated only while one serialized AgentSession turn is running. */
  private activeBudget?: {
    turnSpentUsd: number;
    taskBudgetUsd?: number;
    initialTaskBudgetSpentUsd: number;
  };

  /**
   * @deprecated Compose AgentTurnCapabilities outside AgentLoop. Native
   * callers retain this adapter for one compatibility cycle.
   */
  static fromDependencies(
    config: AgentRuntimeConfig,
    dependencies: AgentTurnCapabilityComposition,
    seedState?: AgentLoopSeedState,
  ): AgentLoop {
    return new AgentLoop(config, createAgentTurnCapabilities(config, dependencies), seedState);
  }

  constructor(
    private readonly config: AgentRuntimeConfig,
    capabilities: AgentTurnCapabilities | AgentTurnCapabilityComposition,
    seedState?: AgentLoopSeedState,
    modelSessionState?: AgentLoopModelSessionState,
  ) {
    this.readFileState = cloneReadFileStateMap(seedState?.readFileState);
    this.writeSnapshots = cloneWriteSnapshotMap(seedState?.writeSnapshots);
    this.allowedReadFiles = new Set(seedState?.allowedReadFiles ?? []);
    this.capabilities = isAgentTurnCapabilities(capabilities)
      ? capabilities
      : createAgentTurnCapabilities(config, capabilities);
    this.modelPort = this.capabilities.model.execution;
    this.toolPort = this.capabilities.toolExecution;
    this.restoreModelSessionState(modelSessionState);
  }

  snapshotFileState(): AgentLoopSeedState {
    return {
      readFileState: cloneReadFileStateMap(this.readFileState),
      writeSnapshots: cloneWriteSnapshotMap(this.writeSnapshots),
      allowedReadFiles: [...this.allowedReadFiles],
    };
  }

  snapshotModelSessionState(): AgentLoopModelSessionState {
    const tokenCalibration = [...this.tokenCalibrationByRoute.values()].map((calibration) => ({ ...calibration }));
    const tokenCaps = [...this.transientTokenCaps.entries()].flatMap(([key, cap]) => {
      if (cap.maxContextTokens === undefined
        && cap.sessionMaxOutputTokens === undefined
        && cap.hardMaxOutputTokens === undefined) return [];
      const [provider, model] = key.split("\u0000");
      if (!provider || !model) return [];
      return [{
        provider,
        model,
        ...(cap.maxContextTokens !== undefined ? { maxContextTokens: cap.maxContextTokens } : {}),
        ...(cap.sessionMaxOutputTokens !== undefined ? { sessionMaxOutputTokens: cap.sessionMaxOutputTokens } : {}),
        ...(cap.hardMaxOutputTokens !== undefined ? { hardMaxOutputTokens: cap.hardMaxOutputTokens } : {}),
      }];
    });
    return {
      ...(tokenCalibration.length > 0 ? { tokenCalibration } : {}),
      ...(tokenCaps.length > 0 ? { tokenCaps } : {}),
    };
  }

  private restoreModelSessionState(state: AgentLoopModelSessionState | undefined): void {
    for (const calibration of state?.tokenCalibration ?? []) {
      this.tokenCalibrationByRoute.set(tokenCalibrationKey(calibration.provider, calibration.model), { ...calibration });
    }
    for (const cap of state?.tokenCaps ?? []) {
      this.transientTokenCaps.set(this.tokenCapKey(cap.provider, cap.model), {
        ...(cap.maxContextTokens !== undefined ? { maxContextTokens: cap.maxContextTokens } : {}),
        ...(cap.sessionMaxOutputTokens !== undefined ? { sessionMaxOutputTokens: cap.sessionMaxOutputTokens } : {}),
        ...(cap.hardMaxOutputTokens !== undefined ? { hardMaxOutputTokens: cap.hardMaxOutputTokens } : {}),
      });
    }
  }

  /**
   * Seed the native file-read state after a caller has retained a prior Read
   * outside the model context. This is an explicit SDK/Gateway control only;
   * normal AgentLoop construction and turns leave the state untouched.
   */
  async seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    return seedAgentReadState(this.config, {
      readFileState: this.readFileState,
      writeSnapshots: this.writeSnapshots,
      allowedReadFiles: this.allowedReadFiles,
    }, filePath, mtimeMs);
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    const timeline = new TurnTimeline(input.turnId);
    const generator = this.runOrdered({
      ...input,
      onCompactPersisted: async (compact) => {
        if (compact.boundary.kind === "compact" && "compactMetadata" in compact.boundary) {
          const metadata = compact.boundary.compactMetadata;
          if (metadata.compactionId) metadata.timeline = timeline.position(`compact:${metadata.compactionId}`);
        }
        await input.onCompactPersisted?.(compact);
      },
      onDurableMessage: async (message) => {
        timeline.message(message);
        await input.onDurableMessage?.(message);
      },
    });
    let completed = false;
    try {
      while (true) {
        const next = await generator.next();
        if (next.done) { completed = true; return next.value; }
        yield timeline.event(next.value);
      }
    } finally {
      // Forward consumer cancellation to the underlying agent iterator. Its
      // return value is intentionally unused when the consumer has stopped.
      if (!completed) await generator.return(undefined as never);
    }
  }

  private async *runOrdered(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.clearTurnScopedTokenCaps();
    this.applyRunModeOverride(input.runMode);
    applyAgentPermissionOverrides(this.config, input);
    for (const filePath of input.allowedReadFiles ?? []) {
      this.allowedReadFiles.add(filePath);
    }
    const startedAt = this.now().toISOString();
    let messages = [...input.messages];
    let turnCount = 1;
    let usage: CanonicalUsage = {};
    const tracksBudget = input.maxBudgetUsd !== undefined || input.taskBudgetUsd !== undefined;
    let spentBudgetUsd = input.initialTaskBudgetSpentUsd ?? 0;
    let turnSpentBudgetUsd = 0;
    this.activeBudget = tracksBudget
      ? {
          turnSpentUsd: 0,
          taskBudgetUsd: input.taskBudgetUsd,
          initialTaskBudgetSpentUsd: input.initialTaskBudgetSpentUsd ?? 0,
        }
      : undefined;
    let permissionDenials: AgentPermissionDenial[] = [];
    let structuredOutput: unknown;
    let finalMessage: CanonicalMessage | undefined;
    const toAgentStatusEvent = (status: AgentStatusMessage): AgentEvent => ({
      type: "agent_status",
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: status.event,
      detail: status.detail,
    });
    const emitStatus = async (status: AgentStatusMessage): Promise<AgentEvent> => {
      await input.onAgentStatusMessage?.(status);
      return toAgentStatusEvent(status);
    };
    const createAbortStatus = (): AgentStatusMessage | undefined => {
      if (!shouldSurfaceAbortStatus(input.abortSignal?.reason)) return undefined;
      return createTurnAbortedStatus({ reason: stringifyAbortReason(input.abortSignal?.reason) });
    };
    const allowedReadFiles = this.allowedReadFiles;
    const applySteerMessages = async function* (pending: AgentSteerMessage[]): AsyncGenerator<AgentEvent, void, unknown> {
      for (const steer of pending) {
        await input.onDurableMessage?.(steer.message);
        for (const filePath of steer.allowedReadFiles ?? []) {
          allowedReadFiles.add(filePath);
        }
        messages.push(steer.message);
        input.onSteerApplied?.(steer.itemId);
        yield {
          type: "steer_applied",
          sessionId: input.sessionId,
          turnId: input.turnId,
          itemId: steer.itemId,
          message: steer.message,
        };
      }
    };
    const captureTurn = async (errored: boolean): Promise<void> => {
      const hook = this.capabilities.contextCapture?.captureTurn;
      if (!hook) return;
      try {
        await hook({
          sessionId: input.sessionId,
          turnId: input.turnId,
          messages,
          errored,
        });
      } catch {
        // captureTurn must never break a turn — context impl already
        // swallows; this catch is defensive.
      }
    };
    /**
     * Single-shot reactive truncate-and-retry guard. Set true after the loop
     * already truncated for a `prompt_too_long` once; subsequent PTL errors
     * fall through to fallback / fail (legacy single-shot semantics).
     */
    let hasAttemptedCompact = false;
    /**
     * Single-shot guard for `max_output_reached` retries. The loop only bumps
     * an explicitly configured cap; catalog-default requests are already sent
     * at the selected model's known output cap and go straight to continuation.
     */
    let hasAttemptedOutputRetry = false;
    /**
     * Single-shot guard for empty assistant responses (no text, no tool
     * calls). The model's thinking may have consumed the full output
     * budget leaving nothing visible; we prompt it once to retry.
     */
    let hasAttemptedEmptyRetry = false;
    /**
     * Multi-turn continuation recovery counter for `max_output_reached`.
     * After the single-shot token bump, the loop injects a continuation
     * prompt and preserves the truncated assistant message so the model can
     * resume from where it was cut off — up to MAX_OUTPUT_RECOVERY_LIMIT
     * times.
     */
    const MAX_OUTPUT_RECOVERY_LIMIT = 50;
    let maxOutputRecoveryCount = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;
    let consecutiveEmptyCount = 0;
    const MAX_JSON_SELF_CORRECT_RETRIES = 3;
    let jsonSelfCorrectCount = 0;
    let hasAttemptedReasoningContentRetry = false;
    /** Prevent a provider that keeps rejecting text-only retries from looping forever. */
    let hasAttemptedImageStrip = false;
    const MAX_STREAM_INTERRUPTION_RECOVERIES = 2;
    let streamInterruptionRecoveryCount = 0;
    const MAX_UNKNOWN_FINISH_RECOVERIES = 2;
    let unknownFinishRecoveryCount = 0;
    const largeFileRepair = new LargeFileRepair();

    /**
     * Circuit breaker: detects loops by fingerprinting each turn's
     * invalid_tool_input errors (toolName + errorMessage). Only identical
     * repeated failures trigger recovery, so changed parameters/tools are not
     * mistaken for the same stuck loop. A one-time grace prompt gives the
     * model a final chance to change strategy before termination.
     */
    const MAX_SAME_INVALID_FINGERPRINT = 3;
    let lastInvalidFingerprint: string | undefined;
    let sameInvalidFingerprintCount = 0;
    let hasUsedInvalidGracePeriod = false;
    let lastToolFailureFingerprint: string | undefined;
    let transientPromptCounter = 0;
    const activeTransientPromptIds = new Set<string>();

    const pushTransientSyntheticPrompt = (prompt: string, purpose: string): void => {
      const transientId = this.capabilities.clock.uuid?.() ?? `transient-${++transientPromptCounter}`;
      messages.push({
        role: "user",
        content: [{ type: "text", text: prompt }],
        metadata: { synthetic: true, transient: true, transientId, purpose },
      });
      activeTransientPromptIds.add(transientId);
    };

    const expireConsumedTransientPrompts = (): void => {
      if (activeTransientPromptIds.size === 0) {
        return;
      }
      messages = removeTransientPromptsById(messages, activeTransientPromptIds);
      activeTransientPromptIds.clear();
    };
    const missingToolResultRecoveryContext = () => ({
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
    });

    const contextOverflowAfterEmergency = async (
      compact: Extract<Awaited<ReturnType<NonNullable<AgentTurnContextPort["tryAutoCompact"]>>>, { type: "compacted" }>,
    ): Promise<{ error: ReturnType<typeof agentError>; result: AgentTurnResult }> => {
      const error = agentError(
        "agent_context_recovery_failed",
        compact.error ?? "context_overflow_after_emergency_compaction",
        {
          code: compact.error,
          snapshot: compact.snapshot,
          diagnostics: compact.result?.diagnostics,
        },
        "The context is still too large after emergency compaction. Start a new session or reduce the request and retry.",
      );
      await this.dispatchLifecycle(input, "StopFailure", { error: error.message });
      const result = this.createTurnResult(input, {
        type: "error",
        stopReason: "prompt_too_long",
        usage,
        permissionDenials,
        turns: turnCount,
        startedAt,
        finalMessage,
        structuredOutput,
        errors: [error],
      });
      return { error, result };
    };

    const stickyInfo = this.capabilities.model.routing?.invalidateSticky?.(input.sessionId);
    let previousTier: string | undefined = stickyInfo?.previousTier;
    const executionRunId = input.execution?.runId
      ?? this.capabilities.clock.uuid?.()
      ?? `${input.sessionId}:${input.turnId}`;

    const continueWithSyntheticPrompt = async (
      decision: LargeFileRepairDecision,
      options: { stripCurrentAssistant?: boolean } = {},
    ): Promise<{
      type: "continue";
      event: AgentEvent;
    } | {
      type: "completed";
      result: AgentTurnResult;
      status?: AgentStatusMessage;
    }> => {
      if (decision.type === "stop") {
        const error = agentError("agent_tool_error_loop", decision.reason);
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [error],
        });
        return { type: "completed", result, status: createToolErrorLoopStatus({ error }) };
      }
      if (options.stripCurrentAssistant !== false) {
        if (decision.strip === "error_pair") {
          messages = stripTrailingErrorPair(messages);
        } else if (decision.strip === "assistant") {
          const last = messages[messages.length - 1];
          if (last?.role === "assistant") {
            messages = messages.slice(0, -1);
          }
        }
      }
      pushTransientSyntheticPrompt(decision.prompt, decision.purpose);
      if (this.currentMaxOutputTokens(this.config.provider, this.config.model) === undefined
        || this.currentMaxOutputTokens(this.config.provider, this.config.model)! < largeFileRepair.recommendedMaxOutputTokens) {
        this.setTransientTokenCap(this.config.provider, this.config.model, {
          sessionMaxOutputTokens: largeFileRepair.recommendedMaxOutputTokens,
        });
      }
      return {
        type: "continue",
        event: {
          type: "turn_continued",
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: "model_error",
        },
      };
    };

    while (true) {
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        const status = createAbortStatus();
        if (status) {
          yield await emitStatus(status);
        }
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const pendingSteers = await input.drainSteerMessages?.() ?? [];
      for await (const event of applySteerMessages(pendingSteers)) {
        yield event;
      }

      let pendingContextBudget: TokenBudgetSnapshot | undefined;
      const ctx = this.capabilities.contextCompaction;
      const preRoutingMaxContextTokens = this.preRoutingMaxContextTokens();
      if (ctx?.tryAutoCompact) {
        try {
          const reservedOutputTokens = this.getReservedOutputTokens();
          const preRouteBudgetRequest = await this.createBudgetRequest(input, messages, {
            maxContextTokens: preRoutingMaxContextTokens,
            reservedOutputTokens,
          });
          const compact = yield* this.awaitCompactionWithEvents(ctx.tryAutoCompact({
            sessionId: input.sessionId,
            turnId: input.turnId,
            messages,
            abortSignal: input.abortSignal,
            budgetStage: "pre_route",
            maxContextTokens: preRoutingMaxContextTokens,
            reservedOutputTokens,
            budgetRequest: preRouteBudgetRequest,
            budgetPreparation: this.createBudgetPreparation(messages, input),
            budgetCalibration: this.budgetCalibrationFor(
              preRouteBudgetRequest.provider,
              preRouteBudgetRequest.model,
            ),
            budgetEvaluator: this.createBudgetEvaluator(input, {
              maxContextTokens: preRoutingMaxContextTokens,
              reservedOutputTokens,
            }),
          }));
          if (compact.type === "compacted") {
            messages = compact.messages;
            this.tokenCalibrationByRoute.clear();
            await this.persistCompactSnapshot(input, compact);
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "auto_compact",
            };
            if (compact.error) {
              const failure = await contextOverflowAfterEmergency(compact);
              yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: failure.error.message };
              yield await emitStatus(createModelRequestFailedStatus({ error: failure.error }));
              yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: failure.error };
              await captureTurn(true);
              yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: failure.result };
              return { result: failure.result, messages };
            }
          }
          pendingContextBudget = compact.snapshot;
        } catch (error: unknown) {
          if (isFatalCompactionError(error)) throw error;
          logAutoCompactFailure("pre-routing", input, error);
          // Auto-compaction must never block the model call — proceed with
          // the original messages if evaluation or summarization fails.
        }
        yield* this.drainEventBuffer();
      }

      let request = await this.createModelRequest(messages, input);
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        const status = createAbortStatus();
        if (status) {
          yield await emitStatus(status);
        }
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }
      this.dispatchLifecycle(input, "PreModelRequest", {
        provider: request.provider,
        model: request.model,
      }).catch(() => {});
      yield {
        type: "model_request_started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: request.model,
        provider: request.provider,
      };

      const modelContext = {
        sessionId: input.sessionId,
        turnId: input.turnId,
          runId: executionRunId,
          operationId: input.execution?.operationId,
          idempotencyKey: input.execution?.idempotencyKey,
        operationDeadline: input.execution?.operationDeadline,
        workspaceId: input.workspaceId,
        storageConfigVersion: input.storageConfigVersion,
        invocationLogSink: input.invocationLogSink,
        abortSignal: input.abortSignal,
        metadata: stickyInfo
          ? {
            previousTier,
            previousProvider: stickyInfo.previousProvider,
            previousModel: stickyInfo.previousModel,
          }
          : previousTier ? { previousTier } : undefined,
        modelOverride: input.modelOverride
          ? { provider: input.modelOverride.provider, model: input.modelOverride.model }
          : undefined,
      };
      let prepared = await this.modelPort.prepare({ request, context: modelContext });
      let decision = { provider: prepared.provider, model: prepared.model };
      let routedProvider = prepared.provider;
      let routedModel = prepared.model;
      const routedLimits = this.getModelTokenLimits(routedProvider, routedModel);
      let routedMaxOutputTokens = prepared.maxOutputTokens ?? routedLimits?.maxOutputTokens;

      let emittedContextBudget = false;
      if (ctx?.tryAutoCompact) {
        const routedMaxCtx = prepared.maxContextTokens ?? this.currentMaxContextTokens(routedProvider, routedModel);
        const currentBudgetMaxCtx = preRoutingMaxContextTokens;
        if (routedMaxCtx !== undefined && routedMaxCtx !== currentBudgetMaxCtx) {
          try {
            const reservedOutputTokens = this.getReservedOutputTokens(routedProvider, routedModel);
            const recompact = yield* this.awaitCompactionWithEvents(ctx.tryAutoCompact({
              sessionId: input.sessionId,
              turnId: input.turnId,
              messages,
              abortSignal: input.abortSignal,
              budgetStage: "routed",
              maxContextTokens: routedMaxCtx,
              reservedOutputTokens,
              budgetRequest: await this.createBudgetRequest(input, messages, {
                decision,
                baseRequest: request,
                prepared,
                maxContextTokens: routedMaxCtx,
                reservedOutputTokens,
              }),
              budgetPreparation: this.createBudgetPreparation(messages, input),
              budgetCalibration: this.budgetCalibrationFor(routedProvider, routedModel),
              budgetEvaluator: this.createBudgetEvaluator(input, {
                decision,
                baseRequest: request,
                prepared,
                maxContextTokens: routedMaxCtx,
                reservedOutputTokens,
              }),
            }));
            if (recompact.type === "compacted") {
              messages = recompact.messages;
              this.tokenCalibrationByRoute.clear();
              request = await this.createModelRequest(messages, input);
              request = this.applyTokenCapsToRequest(request, routedProvider, routedModel);
              prepared.request = snapshotCanonicalModelRequest(
                await this.materializePreparedRequest(prepared, request),
              );
              await this.persistCompactSnapshot(input, recompact);
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "auto_compact",
              };
              if (recompact.error) {
                yield {
                  type: "context_budget",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  snapshot: recompact.snapshot,
                };
                const failure = await contextOverflowAfterEmergency(recompact);
                yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: failure.error.message };
                yield await emitStatus(createModelRequestFailedStatus({ error: failure.error }));
                yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: failure.error };
                await captureTurn(true);
                yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: failure.result };
                return { result: failure.result, messages };
              }
            }
            yield {
              type: "context_budget",
              sessionId: input.sessionId,
              turnId: input.turnId,
              snapshot: recompact.snapshot,
            };
            emittedContextBudget = true;
          } catch (error: unknown) {
            if (isFatalCompactionError(error)) throw error;
            logAutoCompactFailure("post-routing", input, error);
            // Post-routing compaction must never block the model call.
          }
        }
      }
      // `prepare()` is allowed to materialize provider-specific request
      // fields. Apply only AgentLoop-owned caps to that materialized request;
      // never overwrite its prompt, tool schema, metadata, or output cap.
      prepared = {
        ...prepared,
        request: this.applyTokenCapsToRequest(prepared.request, routedProvider, routedModel),
      };
      request = prepared.request;
      this.clearAttemptOutputTokenCap(routedProvider, routedModel);
      if (pendingContextBudget && !emittedContextBudget) {
        yield {
          type: "context_budget",
          sessionId: input.sessionId,
          turnId: input.turnId,
          snapshot: pendingContextBudget,
        };
      }

      const calibrationRequest = prepared.request;
      const requestInputEstimate = await this.capabilities.model.budget?.estimateRequestInput?.(calibrationRequest);
      const calibrationRequestFingerprint = requestFingerprint(calibrationRequest);
      const assembler = createModelMessageAssemblerState(randomUUID());
      let executedRequest: { provider: string; model: string; fingerprint?: string } | undefined;
      try {
        for await (const event of this.modelPort.stream({ prepared, context: modelContext })) {
          if (event.type === "request_started") {
            executedRequest = {
              provider: event.provider,
              model: event.model,
              fingerprint: event.requestFingerprint,
            };
          }
          const blockId = event.type === 'text_delta' || event.type === 'thinking_delta'
            ? getModelStreamBlockId(assembler, event.type === 'text_delta' ? 'text' : 'thinking') : undefined;
          yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event,
            ...(blockId ? { blockId } : {}) };
          applyModelEventToAssembler(assembler, event);
          if (event.type === "error") {
            break;
          }
        }
        if (!stickyInfo?.orchestrating) previousTier = undefined;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          const partialAssembled = assembleAssistantMessage(assembler);
          const safePartialMessage = safeFinalTextMessage(
            partialAssembled.message,
            partialAssembled.toolCalls,
          );
          if (safePartialMessage) {
            finalMessage = safePartialMessage;
            messages.push(safePartialMessage);
            expireConsumedTransientPrompts();
            usage = mergeUsage(usage, partialAssembled.usage);
            yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: safePartialMessage };
            await input.onDurableMessage?.(safePartialMessage);
          }
          const result = this.createTurnResult(input, {
            type: "aborted",
            stopReason: "aborted_streaming",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
          });
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
        const modelError = error instanceof ModelProviderError ? error.error : undefined;
        const stopFailureMsg = modelError?.message ?? (error instanceof Error ? error.message : String(error));
        await this.dispatchLifecycle(input, "StopFailure", { error: stopFailureMsg });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: stopFailureMsg };
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [agentError("agent_model_error", stopFailureMsg, modelError, modelError?.userHint)],
        });
        const abortStatus = createAbortStatus();
        if (abortStatus) {
          yield await emitStatus(abortStatus);
        } else {
          yield await emitStatus(createModelRequestFailedStatus({
            error: result.errors![0]!,
            modelError,
          }));
        }
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (input.abortSignal?.aborted) {
        const partialAssembled = assembleAssistantMessage(assembler);
        const safePartialMessage = safeFinalTextMessage(
          partialAssembled.message,
          partialAssembled.toolCalls,
        );
        if (safePartialMessage) {
          finalMessage = safePartialMessage;
          messages.push(safePartialMessage);
          expireConsumedTransientPrompts();
          usage = mergeUsage(usage, partialAssembled.usage);
          yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: safePartialMessage };
          await input.onDurableMessage?.(safePartialMessage);
        }
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        const status = createAbortStatus();
        if (status) {
          yield await emitStatus(status);
        }
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const assembled = assembleAssistantMessage(assembler);
      // A fallback, media downgrade, or interrupted-stream continuation can
      // change request contents without changing the route. Calibrate only
      // against the exact request whose usage the provider reported.
      if (
        executedRequest?.provider === calibrationRequest.provider
        && executedRequest.model === calibrationRequest.model
        && executedRequest.fingerprint === calibrationRequestFingerprint
      ) {
        this.recordTokenCalibration(calibrationRequest, assembled.usage, requestInputEstimate);
      }
      const assistantMessage = assembled.message;
      const toolCalls = collectToolCalls(assistantMessage);
      const budgetUsage = !tracksBudget
        ? assembled.usage
        : this.resolveBudgetUsage(assembled.usage, requestInputEstimate, assistantMessage);
      usage = mergeUsage(usage, budgetUsage);
      finalMessage = assistantMessage;
      expireConsumedTransientPrompts();

      const budgetProvider = executedRequest?.provider ?? prepared.provider;
      const budgetModel = executedRequest?.model ?? prepared.model;
      const invocationCostUsd = await this.estimateUsageCost(budgetUsage, budgetProvider, budgetModel);
      if (invocationCostUsd !== undefined) {
        spentBudgetUsd += invocationCostUsd;
        turnSpentBudgetUsd += invocationCostUsd;
        if (this.activeBudget) this.activeBudget.turnSpentUsd = turnSpentBudgetUsd;
      }
      const maxTurnBudgetReached = input.maxBudgetUsd !== undefined && turnSpentBudgetUsd >= input.maxBudgetUsd;
      const taskBudgetReached = input.taskBudgetUsd !== undefined && spentBudgetUsd >= input.taskBudgetUsd;
      if (maxTurnBudgetReached || taskBudgetReached) {
        // A completed model request may cross a budget ceiling. Stop before
        // recovery, tool execution, or another model request can add cost or
        // create side effects. The normal, no-budget path is unchanged.
        const taskBudgetIsTerminal = taskBudgetReached && !maxTurnBudgetReached;
        const limit = taskBudgetIsTerminal ? input.taskBudgetUsd! : input.maxBudgetUsd!;
        const errorCode = taskBudgetIsTerminal ? "agent_task_budget_reached" : "agent_max_budget_reached";
        const budgetName = taskBudgetIsTerminal ? "taskBudget.total" : "maxBudgetUsd";
        const error = agentError(
          errorCode,
          `Reached Gateway-owned ${budgetName} ($${limit.toFixed(6)}) after spending $${spentBudgetUsd.toFixed(6)}.`,
          {
            ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
            ...(input.taskBudgetUsd !== undefined ? { taskBudgetUsd: input.taskBudgetUsd } : {}),
            spentBudgetUsd,
            turnSpentBudgetUsd,
            lastInvocationCostUsd: invocationCostUsd,
            provider: budgetProvider,
            model: budgetModel,
          },
          taskBudgetIsTerminal
            ? "Increase taskBudget.total or start a new SDK session with a larger budget."
            : "Increase maxBudgetUsd or start a new turn with a larger budget.",
        );
        const safeMessage = safeFinalTextMessage(
          assistantMessage,
          toolCalls,
        );
        finalMessage = safeMessage;
        if (safeMessage) {
          messages.push(safeMessage);
          yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: safeMessage };
          await input.onDurableMessage?.(safeMessage);
        }
        await this.dispatchLifecycle(input, "StopFailure", { error: error.message });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: error.message };
        yield await emitStatus({
          event: taskBudgetIsTerminal ? "task_budget_reached" : "max_budget_reached",
          kind: "error",
          text: error.message,
          detail: error.details as Record<string, unknown>,
        });
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: taskBudgetIsTerminal ? "task_budget" : "max_budget",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [error],
        });
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error };
        await captureTurn(true);
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const streamInterruption = assembled.error?.streamInterruption;
      if (streamInterruption) {
        if (streamInterruptionRecoveryCount < MAX_STREAM_INTERRUPTION_RECOVERIES) {
          streamInterruptionRecoveryCount++;
          const hasStructuredToolCall = toolCalls.length > 0 || streamInterruption.phase === "tool_call";
          if (hasStructuredToolCall) {
            // Never persist unexecuted structured calls when recovery is cancelled.
            finalMessage = undefined;
          }
          if (streamInterruption.phase === "text" && !hasStructuredToolCall) {
            const partialTextMessage = withoutThinkingBlocks(assistantMessage);
            if (textFromMessage(partialTextMessage).trim().length > 0) {
              finalMessage = partialTextMessage;
              messages.push(partialTextMessage);
              yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: partialTextMessage };
              await input.onDurableMessage?.(partialTextMessage);
            }
          }
          pushTransientSyntheticPrompt(
            buildStreamInterruptionRecoveryPrompt(
              hasStructuredToolCall ? { ...streamInterruption, phase: "tool_call" } : streamInterruption,
            ),
            "stream_interruption_recovery",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        const error = agentError(
          "agent_model_error",
          `Stream interruption recovery exhausted after ${MAX_STREAM_INTERRUPTION_RECOVERIES} attempts (${streamInterruption.phase}).`,
          assembled.error,
          "The model stream repeatedly disconnected. Retry the turn or switch providers.",
        );
        const exhaustedMessage = safeFinalTextMessage(assistantMessage, toolCalls);
        finalMessage = exhaustedMessage;
        if (exhaustedMessage) {
          messages.push(exhaustedMessage);
          yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: exhaustedMessage };
          await input.onDurableMessage?.(exhaustedMessage);
        }
        await this.dispatchLifecycle(input, "StopFailure", { error: error.message });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: error.message };
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [error],
        });
        yield await emitStatus(createModelRequestFailedStatus({ error, modelError: assembled.error }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error };
        await captureTurn(true);
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }
      streamInterruptionRecoveryCount = 0;

      if (!assembled.error && assembled.hasMessageEnd && assembled.finishReason === "unknown") {
        if (unknownFinishRecoveryCount < MAX_UNKNOWN_FINISH_RECOVERIES) {
          unknownFinishRecoveryCount++;
          const partialTextMessage = withoutThinkingBlocks(assistantMessage);
          if (toolCalls.length === 0 && textFromMessage(partialTextMessage).trim().length > 0) {
            finalMessage = partialTextMessage;
            messages.push(partialTextMessage);
            yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: partialTextMessage };
            await input.onDurableMessage?.(partialTextMessage);
          }
          pushTransientSyntheticPrompt(
            buildUnknownFinishRecoveryPrompt(toolCalls),
            "unknown_finish_recovery",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        const error = agentError(
          "agent_model_error",
          `Unknown finish reason recovery exhausted after ${MAX_UNKNOWN_FINISH_RECOVERIES} attempts.`,
          undefined,
          "The provider repeatedly ended the stream without a recognized finish reason. Retry the turn or switch providers.",
        );
        const exhaustedMessage = safeFinalTextMessage(assistantMessage, toolCalls);
        finalMessage = exhaustedMessage;
        if (exhaustedMessage) {
          messages.push(exhaustedMessage);
          yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: exhaustedMessage };
          await input.onDurableMessage?.(exhaustedMessage);
        }
        await this.dispatchLifecycle(input, "StopFailure", { error: error.message });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: error.message };
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [error],
        });
        yield await emitStatus(createModelRequestFailedStatus({ error }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error };
        await captureTurn(true);
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }
      unknownFinishRecoveryCount = 0;

      // When jsonrepair silently "fixed" truncated JSON and the response
      // was cut by max_tokens, the tool call arguments are likely incomplete
      // (e.g. half-written file content). Apply the same recovery as
      // max_output_reached: token doubling → continuation prompt → give up.
      //
      // This gate intentionally runs before durable assistant emission. The
      // recovered response should replace the dirty repaired/truncated message,
      // not leave an unmatched tool_call in the transcript.
      if (assembled.hasRepairedToolCalls && (assembled.finishReason === "length" || assembled.finishReason === "tool_call" || assembled.finishReason === "stop")) {
        console.warn(
          `[AgentLoop] Blocking ${toolCalls.length} repaired-but-truncated tool call(s) — entering max_output recovery`,
        );

        const largeFileDecision = largeFileRepair.recoverFromRepairedTruncation(toolCalls);
        if (largeFileDecision) {
          const continued = await continueWithSyntheticPrompt(largeFileDecision, { stripCurrentAssistant: false });
          if (continued.type === "completed") {
            if (continued.status) {
              yield await emitStatus(continued.status);
            }
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }

        // Phase A: token doubling (if not yet attempted)
          if (!hasAttemptedOutputRetry) {
            hasAttemptedOutputRetry = true;
            const nextMaxOutputTokens = resolveOutputTokenRetryBump({
              currentMaxOutputTokens: this.currentMaxOutputTokens(decision.provider, decision.model),
              modelMaxOutputTokens: routedMaxOutputTokens,
            });
            if (nextMaxOutputTokens !== undefined) {
              const previousOutput = this.currentMaxOutputTokens(decision.provider, decision.model);
              this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
              yield {
                type: "token_cap_adjusted",
                sessionId: input.sessionId,
                turnId: input.turnId,
                provider: decision.provider,
                model: decision.model,
                cap: "output",
                previous: previousOutput,
                next: nextMaxOutputTokens,
                reason: "max-output-retry-bump",
              };
              yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
        }

        // Phase B: continuation recovery
        if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          maxOutputRecoveryCount++;
          pushTransientSyntheticPrompt(
            "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
              + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
            "max_output_recovery",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // Phase C: exhausted. Do not execute repaired/truncated calls; the
        // arguments may be syntactically repaired while semantically partial.
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError(
            "agent_model_error",
            "Recovered tool call still looked repaired/truncated after max-output recovery was exhausted.",
          )],
        });
        yield await emitStatus(createToolCallRecoveryExhaustedStatus({
          error: result.errors![0]!,
          attempts: maxOutputRecoveryCount,
          reason: "repaired_truncated_tool_calls",
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (!assembled.error && toolCalls.length === 0 && textFromMessage(assistantMessage).length === 0) {
        if (maxOutputRecoveryCount > 0) {
          consecutiveEmptyCount++;
          if (consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY
            && maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            if (assembled.finishReason === "length") {
              const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
              const nextMaxOutputTokens = clampOutputToModelCap(
                Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
                routedMaxOutputTokens,
              );
              if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
                this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
                yield {
                  type: "empty_output_recovery",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  provider: decision.provider,
                  model: decision.model,
                  finishReason: assembled.finishReason,
                  previousMaxOutputTokens,
                  nextMaxOutputTokens,
                };
              }
            }
            pushTransientSyntheticPrompt(
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                + "Pick up mid-sentence if that is where the cut happened.",
              "max_output_recovery",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
          finalMessage = messages.filter((m) => m.role === "assistant").at(-1);
          const status = createEmptyResponseStatus({
            provider: request.provider,
            model: request.model,
            attempts: consecutiveEmptyCount,
          });
          yield await emitStatus(status);
          const result = this.createTurnResult(input, {
            type: "success",
            stopReason: "completed",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
          });
          await captureTurn(true);
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }

        if (!hasAttemptedEmptyRetry) {
          hasAttemptedEmptyRetry = true;
          maxOutputRecoveryCount++;
          if (assembled.finishReason === "length") {
            const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
            const nextMaxOutputTokens = clampOutputToModelCap(
              Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
              routedMaxOutputTokens,
            );
            if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
              this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
              yield {
                type: "empty_output_recovery",
                sessionId: input.sessionId,
                turnId: input.turnId,
                provider: decision.provider,
                model: decision.model,
                finishReason: assembled.finishReason,
                previousMaxOutputTokens,
                nextMaxOutputTokens,
              };
            }
          }
          pushTransientSyntheticPrompt(
            "Your previous response was empty (thinking only, no visible text). "
              + "Please provide your answer as visible text output.",
            "empty_response_retry",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        const status = createEmptyResponseStatus({
          provider: request.provider,
          model: request.model,
          attempts: 2,
        });
        yield await emitStatus(status);
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage: messages.filter((m) => m.role === "assistant").at(-1),
        });
        await captureTurn(true);
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      messages.push(assistantMessage);
      yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: assistantMessage };
      await input.onDurableMessage?.(assistantMessage);

      if (assembled.error) {
        if (
          !hasAttemptedReasoningContentRetry &&
          isMissingReasoningContentError(assembled.error)
        ) {
          hasAttemptedReasoningContentRetry = true;
          messages = addEmptyReasoningContentMarkers(messages);
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (toolCalls.length > 0) {
          const projected = projectToolResults(
            toolCalls.map((call) =>
              createMissingToolResult(
                call,
                this.now,
                "Model error interrupted tool execution.",
                missingToolResultRecoveryContext(),
              )
            ),
          );
          messages.push(...projected);
          yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: projected[0]! };
          for (const msg of projected) {
            await input.onDurableMessage?.(msg);
          }
        }

        if (
          this.config.jsonSelfCorrect &&
          assembled.error.code === "invalid_tool_arguments" &&
          jsonSelfCorrectCount < MAX_JSON_SELF_CORRECT_RETRIES
        ) {
          jsonSelfCorrectCount++;
          pushTransientSyntheticPrompt(
            "Your previous tool call contained invalid JSON in the arguments and could not be parsed. "
              + "Please retry with valid JSON. Common issues: missing quotes around keys/values, "
              + "trailing commas, unescaped special characters in strings.",
            "json_self_correct",
          );
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // Reactive recovery: ask context runtime if it can recover from the
        // model error (e.g. `prompt_too_long` → truncate head and retry).
        // Single-shot per turn — see legacy parity §3.1 #8.
        const reactive = await this.tryReactiveRecover(input, assembled.error, messages, hasAttemptedCompact);
        if (reactive && reactive.type === "adjust_output_and_retry" && !hasAttemptedOutputRetry) {
          hasAttemptedOutputRetry = true;
          const target = modelErrorTarget(assembled.error, decision.provider, decision.model);
          const previousOutput = this.currentMaxOutputTokens(target.provider, target.model);
          this.setTransientTokenCap(target.provider, target.model, reactive.scope === "attempt"
            ? { attemptMaxOutputTokens: reactive.maxOutputTokens }
            : { hardMaxOutputTokens: reactive.maxOutputTokens });
          if (target.provider !== decision.provider || target.model !== decision.model) {
            this.setTransientTokenCap(decision.provider, decision.model, { attemptMaxOutputTokens: reactive.maxOutputTokens });
          }
          messages = stripTrailingErrorPair(messages);
          yield {
            type: "token_cap_adjusted",
            sessionId: input.sessionId,
            turnId: input.turnId,
            provider: target.provider,
            model: target.model,
            cap: "output",
            previous: previousOutput,
            next: reactive.maxOutputTokens,
            reason: reactive.reason,
          };
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "compact_and_retry" && !hasAttemptedCompact) {
          const target = modelErrorTarget(assembled.error, decision.provider, decision.model);
          const previousContext = this.currentMaxContextTokens(target.provider, target.model);
          if (reactive.maxContextTokens !== undefined) {
            this.setTransientTokenCap(target.provider, target.model, { maxContextTokens: reactive.maxContextTokens });
            yield {
              type: "token_cap_adjusted",
              sessionId: input.sessionId,
              turnId: input.turnId,
              provider: target.provider,
              model: target.model,
              cap: "context",
              previous: previousContext,
              next: reactive.maxContextTokens,
              reason: reactive.reason,
            };
          }
          if (reactive.maxOutputTokens !== undefined) {
            const previousOutput = this.currentMaxOutputTokens(target.provider, target.model);
            this.setTransientTokenCap(target.provider, target.model, { attemptMaxOutputTokens: reactive.maxOutputTokens });
            if (target.provider !== decision.provider || target.model !== decision.model) {
              this.setTransientTokenCap(decision.provider, decision.model, { attemptMaxOutputTokens: reactive.maxOutputTokens });
            }
            yield {
              type: "token_cap_adjusted",
              sessionId: input.sessionId,
              turnId: input.turnId,
              provider: target.provider,
              model: target.model,
              cap: "output",
              previous: previousOutput,
              next: reactive.maxOutputTokens,
              reason: reactive.reason,
            };
          }
          messages = stripTrailingErrorPair(messages);
          if (ctx?.tryAutoCompact) {
            try {
              const maxContextTokens = this.currentMaxContextTokens(target.provider, target.model);
              const reservedOutputTokens = this.getReservedOutputTokens(target.provider, target.model);
              const recoveryDecision = {
                ...decision,
                provider: target.provider,
                model: target.model,
              };
              const compact = yield* this.awaitCompactionWithEvents(ctx.tryAutoCompact({
                sessionId: input.sessionId,
                turnId: input.turnId,
                messages,
                abortSignal: input.abortSignal,
                budgetStage: "recovery",
                maxContextTokens,
                reservedOutputTokens,
                budgetRequest: await this.createBudgetRequest(input, messages, {
                  decision: recoveryDecision,
                  baseRequest: { ...request, provider: target.provider, model: target.model },
                  maxContextTokens,
                  reservedOutputTokens,
                }),
                budgetPreparation: this.createBudgetPreparation(messages, input),
                budgetCalibration: this.budgetCalibrationFor(target.provider, target.model),
                budgetEvaluator: this.createBudgetEvaluator(input, {
                  decision: recoveryDecision,
                  baseRequest: { ...request, provider: target.provider, model: target.model },
                  maxContextTokens,
                  reservedOutputTokens,
                }),
                allowFallbackOnFailure: true,
              }));
              if (compact.type === "compacted") {
                messages = compact.messages;
                this.tokenCalibrationByRoute.clear();
                await this.persistCompactSnapshot(input, compact);
                if (compact.error) {
                  const failure = await contextOverflowAfterEmergency(compact);
                  yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: failure.error.message };
                  yield await emitStatus(createModelRequestFailedStatus({ error: failure.error }));
                  yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: failure.error };
                  await captureTurn(true);
                  yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: failure.result };
                  return { result: failure.result, messages };
                }
              } else {
                messages = truncateHeadKeepRatio(messages, 0.5);
                this.tokenCalibrationByRoute.clear();
              }
            } catch (error: unknown) {
              if (isFatalCompactionError(error)) throw error;
              logAutoCompactFailure("model-error-recovery", input, error);
              messages = truncateHeadKeepRatio(messages, 0.5);
              this.tokenCalibrationByRoute.clear();
            }
          } else {
            messages = truncateHeadKeepRatio(messages, 0.5);
            this.tokenCalibrationByRoute.clear();
          }
          hasAttemptedCompact = true;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "truncate_head_and_retry") {
          // Drop the failed assistant message + any synthetic tool_result we just
          // pushed so the retry doesn't carry a half-baked tool_call. Then apply
          // keepRatio so the cap is computed against valid history only.
          messages = stripTrailingErrorPair(messages);
          messages = truncateHeadKeepRatio(messages, reactive.keepRatio);
          this.tokenCalibrationByRoute.clear();
          hasAttemptedCompact = true;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "strip_images_and_retry" && !hasAttemptedImageStrip) {
          hasAttemptedImageStrip = true;
          messages = stripTrailingErrorPair(messages);
          messages = stripImagesFromMessages(messages);
          this.tokenCalibrationByRoute.clear();
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // `max_output_reached`: output token limit hit (or truncated JSON
        // reclassified from invalid_tool_arguments when finishReason=length).
        //
        // Phase A — single-shot token doubling for explicit caps only.
        // Phase B — multi-turn continuation: keep the truncated assistant
        // message in context and inject a "resume" prompt so the model can
        // pick up where it was cut off (up to MAX_OUTPUT_RECOVERY_LIMIT).
        // Phase C — exhausted: fall through to error surfacing.
        if (assembled.error.code === "max_output_reached") {
          // Phase A
          if (!hasAttemptedOutputRetry) {
            hasAttemptedOutputRetry = true;
            const nextMaxOutputTokens = resolveOutputTokenRetryBump({
              currentMaxOutputTokens: this.currentMaxOutputTokens(decision.provider, decision.model),
              modelMaxOutputTokens: routedMaxOutputTokens,
            });
            if (nextMaxOutputTokens !== undefined) {
              messages = stripTrailingErrorPair(messages);
              const previousOutput = this.currentMaxOutputTokens(decision.provider, decision.model);
              this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
              yield {
                type: "token_cap_adjusted",
                sessionId: input.sessionId,
                turnId: input.turnId,
                provider: decision.provider,
                model: decision.model,
                cap: "output",
                previous: previousOutput,
                next: nextMaxOutputTokens,
                reason: "max-output-retry-bump",
              };
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "model_error",
              };
              continue;
            }
          }

          // Phase B
          if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            pushTransientSyntheticPrompt(
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
              "max_output_recovery",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
          // Phase C: fall through to error surfacing
        }

        // Cross-provider fallback decisions are now owned by RouterRuntime
        // (see `runFallbackChain` + `zeroUsageRetry`); the loop only
        // classifies the surfaced error and falls through.
        const classified = classifyModelError(assembled.error);
        await this.dispatchLifecycle(input, "StopFailure", { error: assembled.error });
        yield { type: "stop_failure", sessionId: input.sessionId, turnId: input.turnId, error: typeof assembled.error === "string" ? assembled.error : JSON.stringify(assembled.error) };
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: classified.stopReason,
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [classified.error],
        });
        yield await emitStatus(createModelRequestFailedStatus({
          error: classified.error,
          modelError: assembled.error,
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (toolCalls.length === 0) {
        const assistantText = textFromMessage(assistantMessage);

        // Global guard: empty assistant response (no text, no tool calls).
        // The model produced nothing visible — typically because extended
        // thinking consumed the entire output budget.
        if (assistantText.length === 0) {
          messages.pop();

          if (maxOutputRecoveryCount > 0) {
            consecutiveEmptyCount++;
            if (consecutiveEmptyCount < MAX_CONSECUTIVE_EMPTY
              && maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
              maxOutputRecoveryCount++;
              if (assembled.finishReason === "length") {
                const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
                const nextMaxOutputTokens = clampOutputToModelCap(
                  Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
                  routedMaxOutputTokens,
                );
                if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
                  this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
                  yield {
                    type: "empty_output_recovery",
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    provider: decision.provider,
                    model: decision.model,
                    finishReason: assembled.finishReason,
                    previousMaxOutputTokens,
                    nextMaxOutputTokens,
                  };
                }
              }
              pushTransientSyntheticPrompt(
                "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                  + "Pick up mid-sentence if that is where the cut happened.",
                "max_output_recovery",
              );
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "model_error",
              };
              continue;
            }
            // Exhausted consecutive empty retries — surface a UI-only status
            // message instead of injecting diagnostic assistant text into the
            // model transcript.
            finalMessage = messages.filter((m) => m.role === "assistant").at(-1);
            const status = createEmptyResponseStatus({
              provider: request.provider,
              model: request.model,
              attempts: consecutiveEmptyCount,
            });
            yield await emitStatus(status);
            const result = this.createTurnResult(input, {
              type: "success",
              stopReason: "completed",
              usage,
              permissionDenials,
              turns: turnCount,
              startedAt,
              finalMessage,
            });
            await captureTurn(true);
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
            return { result, messages };
          } else if (!hasAttemptedEmptyRetry) {
            // First occurrence: prompt the model to produce visible output.
            hasAttemptedEmptyRetry = true;
            maxOutputRecoveryCount++;
            if (assembled.finishReason === "length") {
              const previousMaxOutputTokens = this.currentMaxOutputTokens(decision.provider, decision.model);
              const nextMaxOutputTokens = clampOutputToModelCap(
                Math.max((previousMaxOutputTokens ?? 0) * 2, EMPTY_LENGTH_OUTPUT_RETRY_FLOOR),
                routedMaxOutputTokens,
              );
              if (nextMaxOutputTokens !== undefined && nextMaxOutputTokens !== previousMaxOutputTokens) {
                this.setTransientTokenCap(decision.provider, decision.model, { requestedMaxOutputTokens: nextMaxOutputTokens });
                yield {
                  type: "empty_output_recovery",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  provider: decision.provider,
                  model: decision.model,
                  finishReason: assembled.finishReason,
                  previousMaxOutputTokens,
                  nextMaxOutputTokens,
                };
              }
            }
            pushTransientSyntheticPrompt(
              "Your previous response was empty (thinking only, no visible text). "
                + "Please provide your answer as visible text output.",
              "empty_response_retry",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          } else {
            const status = createEmptyResponseStatus({
              provider: request.provider,
              model: request.model,
              attempts: 2,
            });
            yield await emitStatus(status);
          }
          // fall through to normal stop
        }

        // Pure-text output truncated by max_output_tokens: the model was
        // mid-sentence with no tool calls. Unlike tool-call truncation we
        // skip the "strip-and-retry-with-doubled-tokens" phase (Phase A)
        // because (a) the text already generated is valid and discarding it
        // wastes tokens, and (b) blindly doubling maxOutputTokens may
        // exceed the provider's model cap and trigger a 400 error.
        // Instead, keep the truncated assistant message in context and
        // inject a continuation prompt so the model resumes from the cut.
        if (assembled.finishReason === "length") {
          consecutiveEmptyCount = 0;
          if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            pushTransientSyntheticPrompt(
              "Output token limit hit. Resume directly - no apology, no recap of what you were doing. "
                + "Pick up mid-sentence if that is where the cut happened.",
              "max_output_recovery",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }
          // Exhausted — fall through to normal completion with whatever
          // text was produced so far.
          const status = createMaxOutputRecoveryExhaustedStatus({ attempts: maxOutputRecoveryCount });
          yield await emitStatus(status);
        }

        const largeFileDecision = largeFileRepair.onNoToolCalls();
        if (largeFileDecision) {
          const continued = await continueWithSyntheticPrompt(largeFileDecision);
          if (continued.type === "completed") {
            if (continued.status) {
              yield await emitStatus(continued.status);
            }
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }

        // A steer starts another model iteration, so it must obey the same
        // turn budget as tool-driven continuation. Leave guidance in the
        // mailbox when the budget is exhausted; TurnRunner will report it as
        // unapplied and the host can keep it queued for a later turn.
        const canContinueForSteer = !input.maxTurns || turnCount < input.maxTurns;
        const terminalSteers = canContinueForSteer
          ? await input.drainOrCloseSteerMailbox?.()
          : undefined;
        if (terminalSteers && terminalSteers.messages.length > 0) {
          for await (const event of applySteerMessages(terminalSteers.messages)) {
            yield event;
          }
          turnCount += 1;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "user_steer",
          };
          continue;
        }

        const stopHooks = await this.dispatchLifecycle(input, "Stop", {
          stopHookActive: false,
          lastAssistantMessage: textFromMessage(assistantMessage),
        });
        yield { type: "stop_requested", sessionId: input.sessionId, turnId: input.turnId };
        messages.push(...stopHooks.messages);
        const stopBlock = findLifecycleBlock(stopHooks);
        if (stopBlock) {
          const result = this.createTurnResult(input, {
            type: "error",
            stopReason: "tool_error",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
            structuredOutput,
            errors: [agentError("agent_unsupported_feature", stopBlock.reason)],
          });
          yield await emitStatus(createLifecycleBlockedStatus({
            error: result.errors![0]!,
            stage: "stop",
          }));
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
        const finishStatus = createFinishReasonStatus(assembled.finishReason, assistantText);
        if (finishStatus) {
          yield await emitStatus(finishStatus);
        }

        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
        });
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      yield { type: "tool_calls_detected", sessionId: input.sessionId, turnId: input.turnId, calls: toolCalls };
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      let results: PilotDeckToolResult[];
      try {
        const toolContext = this.createToolContext(input);
        if (assembled.finishReason === "length" || assembled.hasRepairedToolCalls) {
          toolContext.outputTruncated = true;
        }
        results = yield* this.executeToolsWithEventPump(
          toolCalls,
          toolContext,
          input,
          executionRunId,
        );
      } catch (error) {
        if (isTerminalToolError(error)) throw error;
        results = toolCalls.map((call) =>
          createMissingToolResult(
            call,
            this.now,
            error instanceof Error ? error.message : String(error),
            missingToolResultRecoveryContext(),
          ),
        );
      }
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }
      yield* this.drainEventBuffer();

      let pairedResults = ensureToolResultPairing(
        toolCalls,
        results,
        this.now,
        "Tool execution did not produce a result.",
        missingToolResultRecoveryContext(),
      );
      const repeatedFailure = detectRepeatedToolFailure(
        pairedResults,
        lastToolFailureFingerprint,
      );
      pairedResults = annotateRepeatedToolFailures(pairedResults, repeatedFailure.repeatedKeys);
      lastToolFailureFingerprint = repeatedFailure.currentFingerprint;
      const toolResultRepair = largeFileRepair.analyzeToolResults(pairedResults, {
        outputTruncated: assembled.finishReason === "length" || assembled.hasRepairedToolCalls === true,
        repairedToolCalls: assembled.hasRepairedToolCalls === true,
        finishReason: assembled.finishReason,
      });
      permissionDenials = [...permissionDenials, ...collectPermissionDenials(pairedResults)];
      for (const result of pairedResults) {
        if (result.type === "success" && result.metadata?.structuredOutput) {
          structuredOutput = result.data;
        }
        const requestedMode = readRequestedMode(result.type === "success" ? result.data : undefined);
        if (requestedMode) {
          let effectiveMode = requestedMode;

          if (requestedMode === "plan" && this.config.permissionMode !== "plan") {
            this.config.permissionModeBeforePlan = this.config.permissionMode;
          } else if (this.config.permissionMode === "plan" && requestedMode !== "plan") {
            if (this.config.permissionModeBeforePlan) {
              effectiveMode = this.config.permissionModeBeforePlan;
              this.config.permissionModeBeforePlan = undefined;
            }
          }

          this.config.permissionMode = effectiveMode;
          this.config.permissionContext.mode = effectiveMode;
          yield { type: "mode_change_requested", sessionId: input.sessionId, turnId: input.turnId, mode: effectiveMode };
        }
        yield { type: "tool_result", sessionId: input.sessionId, turnId: input.turnId, result };
      }

      const projected = projectToolResults(pairedResults);
      // Route the freshly projected tool_result message through the context
      // runtime so large payloads land on disk via `ToolResultBudget`. When
      // the runtime doesn't implement `applyToolResults` (e.g. NullContext),
      // we simply append the raw projection (legacy behaviour).
      const [toolResultMsg, ...supplementalMsgs] = projected;
      const supplementalInputs = bindSupplementalMessagesToToolCalls(pairedResults, supplementalMsgs);
      let appendedMessages: CanonicalMessage[] = projected;
      const ctxApply = this.capabilities.contextToolResults?.applyToolResults;
      if (ctxApply) {
        try {
          const applied = await ctxApply({
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolResultMessage: toolResultMsg,
            supplementalMessages: supplementalInputs,
            messages,
          });
          messages = applied.messages;
          appendedMessages = applied.appendedMessages ?? projected;
          // A remote context provider returns these arrays through a
          // serialization boundary, so their tail entries no longer share
          // object identity. Reattach the canonical appended instances so
          // timeline annotations applied to emitted events also reach the
          // next model request.
          if (applied.appendedMessages && appendedMessages.length <= messages.length) {
            messages = [
              ...messages.slice(0, messages.length - appendedMessages.length),
              ...appendedMessages,
            ];
          }
        } catch {
          messages.push(...projected);
        }
      } else {
        messages.push(...projected);
      }
      for (const appended of appendedMessages) {
        yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: appended };
        await input.onDurableMessage?.(appended);
      }

      if (toolResultRepair) {
        const continued = await continueWithSyntheticPrompt(toolResultRepair);
        if (continued.type === "completed") {
          if (continued.status) {
            yield await emitStatus(continued.status);
          }
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
          await captureTurn(continued.result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
          return { result: continued.result, messages };
        }
        yield continued.event;
        continue;
      }

      const lifecycleBlock = findToolLifecycleBlock(pairedResults);
      if (lifecycleBlock) {
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError("agent_unsupported_feature", lifecycleBlock.reason)],
        });
        yield await emitStatus(createLifecycleBlockedStatus({
          error: result.errors![0]!,
          stage: "tool_lifecycle",
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      // Circuit breaker: detect turns where ALL tool calls returned
      // invalid_tool_input. Uses fingerprint-based detection (toolName +
      // errorMessage), and injects one grace prompt before final termination.
      // When LargeFileRepair is actively managing recovery, defer to its own
      // attempt limits instead of terminating here.
      const allInvalid = pairedResults.length > 0 && pairedResults.every(
        (r) => r.type === "error" && r.error.code === "invalid_tool_input",
      );
      if (allInvalid && largeFileRepair.hasPendingRepair) {
        const fallbackRepair = largeFileRepair.onInvalidToolInput();
        if (fallbackRepair) {
          const continued = await continueWithSyntheticPrompt(fallbackRepair);
          if (continued.type === "completed") {
            if (continued.status) {
              yield await emitStatus(continued.status);
            }
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }
      }
      if (allInvalid) {
        const fingerprint = buildInvalidFingerprint(pairedResults);
        if (fingerprint === lastInvalidFingerprint) {
          sameInvalidFingerprintCount++;
        } else {
          sameInvalidFingerprintCount = 1;
          lastInvalidFingerprint = fingerprint;
          hasUsedInvalidGracePeriod = false;
        }

        if (sameInvalidFingerprintCount >= MAX_SAME_INVALID_FINGERPRINT) {
          if (!hasUsedInvalidGracePeriod) {
            hasUsedInvalidGracePeriod = true;
            pushTransientSyntheticPrompt(CIRCUIT_BREAKER_GRACE_PROMPT, "circuit_breaker_grace");
            yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "model_error" };
            continue;
          }

          const result = this.createTurnResult(input, {
            type: "error",
            stopReason: "tool_error",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
            structuredOutput,
            errors: [agentError(
              "agent_tool_error_loop",
              `Terminated: ${sameInvalidFingerprintCount} consecutive turns with identical tool input validation failures (same tool + same error). The model appears stuck in a loop.`,
              undefined,
              "The model is repeatedly producing invalid tool calls. Consider switching to a more capable model via settings.",
            )],
          });
          yield await emitStatus(createToolErrorLoopStatus({
            error: result.errors![0]!,
            repeatedFailures: sameInvalidFingerprintCount,
          }));
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
      } else {
        sameInvalidFingerprintCount = 0;
        lastInvalidFingerprint = undefined;
        hasUsedInvalidGracePeriod = false;
        if (!pairedResults.some((r) => r.type === "error")) {
          lastToolFailureFingerprint = undefined;
        }
        maxOutputRecoveryCount = 0;
        consecutiveEmptyCount = 0;
        hasAttemptedOutputRetry = false;
        hasAttemptedEmptyRetry = false;
        hasAttemptedImageStrip = false;
      }

      if (this.config.stopOnStructuredOutput && structuredOutput !== undefined) {
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
        });
        const status = createStructuredOutputCompletedStatus();
        yield await emitStatus(status);
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const nextTurnCount = turnCount + 1;
      if (input.maxTurns && nextTurnCount > input.maxTurns) {
        const maxTurnsError = agentError(
          "agent_max_turns_reached",
          `Reached maximum number of turns (${input.maxTurns}).`,
          undefined,
          "Max turn limit reached. Increase maxTurns in config or break the task into smaller steps.",
        );
        const result = this.createTurnResult(input, {
          type: "max_turns",
          stopReason: "max_turns",
          usage,
          permissionDenials,
          turns: nextTurnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [maxTurnsError],
        });
        const status = createMaxTurnsStatus({ maxTurns: input.maxTurns, error: maxTurnsError });
        yield await emitStatus(status);
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      turnCount = nextTurnCount;
      yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "next_turn" };
    }
  }

  private async tryReactiveRecover(
    input: AgentLoopInput,
    error: CanonicalModelError,
    messages: CanonicalMessage[],
    hasAttemptedCompact: boolean,
  ): Promise<ContextRecoveryDecision | undefined> {
    const ctx = this.capabilities.contextRecovery;
    if (!ctx) {
      return undefined;
    }
    try {
      return await ctx.recoverFromModelError({
        sessionId: input.sessionId,
        turnId: input.turnId,
        error,
        messages,
        hasAttemptedCompact,
      });
    } catch {
      // Recovery probe should never block fallback. Pretend the runtime gave up.
      return undefined;
    }
  }

  private async createModelRequest(
    messages: CanonicalMessage[],
    input: AgentLoopInput,
    options: { emitInstructionEvents?: boolean; previewOnly?: boolean } = {},
  ): Promise<CanonicalModelRequest> {
    // A host-owned sidecar catalog can reveal tools after prior calls. Refresh
    // only at a model-request boundary so one tool batch sees a stable view.
    await this.toolPort.refresh?.();
    const contextRuntime = this.capabilities.contextPreparation;
    const prepareInput = this.createContextPrepareInput(messages, input);
    const prepared = await contextRuntime.prepareForModel({
      ...prepareInput,
      previewOnly: options.previewOnly,
    });

    if (options.emitInstructionEvents !== false) {
      this.dispatchLifecycle(input, "InstructionsLoaded", {
        hasSystemPrompt: !!prepared.systemPrompt,
      }).catch(() => {});
      this.capabilities.events.emit?.({
        type: "instructions_loaded",
        sessionId: input.sessionId,
        turnId: input.turnId,
        hasSystemPrompt: !!prepared.systemPrompt,
      });
    }

    const assembled = await finalizePreparedModelRequest({
      request: {
        provider: prepareInput.provider,
        model: prepareInput.model,
        messages: [],
        systemPrompt: this.config.systemPrompt,
        tools: [],
        toolChoice: this.config.toolChoice,
        // Recovery state is session-owned and must become the request baseline
        // before a provider applies a narrower explicit cap.
        maxOutputTokens: this.currentMaxOutputTokens(prepareInput.provider, prepareInput.model)
          ?? this.config.maxOutputTokens,
        speed: input.modelOverride?.speed,
        thinking: input.modelOverride?.thinking ?? this.config.thinking,
        stream: true,
        metadata: this.config.metadata,
      },
      prepared,
      permissionMode: this.config.permissionMode,
      fallbackSystemPrompt: this.config.systemPrompt,
    });
    for (const diagnostic of assembled.diagnostics) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pilotdeck] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.mediaType}, ${diagnostic.path})`,
      );
    }

    return assembled.request;
  }

  /** Build the serializable prompt intent used by normal and preview requests. */
  private createContextPrepareInput(
    messages: CanonicalMessage[],
    input: AgentLoopInput,
  ): AgentContextPrepareInput {
    const planTodo = this.capabilities.planMode.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const canElicit = input.canElicit === true && this.capabilities.interaction.elicitationAvailable === true;
    const promptBlockedToolNames = canPrompt
      ? new Set<string>()
      : new Set(
          this.toolPort.list()
            .filter((tool) => requiresPromptCapability(tool, {})
              && !(canElicit && tool.name === "ask_user_question"))
            .map((tool) => tool.name),
        );
    let toolDefinitions = this.toolPort.list()
      .filter((tool) => !promptBlockedToolNames.has(tool.name));
    if (input.allowPlanModeTools !== true) {
      toolDefinitions = toolDefinitions.filter(
        (tool) => tool.name !== "enter_plan_mode" && tool.name !== "exit_plan_mode",
      );
    }
    const requestMessages = normalizeMessagesForModelRequest(messages);
    let tools = toolDefinitions.map(toolToCanonicalSchema);
    if (this.config.runMode === "ask") {
      tools = filterAskModeTools(toolDefinitions);
    }
    const requestProvider = input.modelOverride?.provider ?? this.config.provider;
    const requestModel = input.modelOverride?.model ?? this.config.model;
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      runtimeContextSurface: this.config.runtimeContextSurface,
      provider: requestProvider,
      model: requestModel,
      protocol: this.capabilities.model.metadata.getModelProtocol?.(requestProvider),
      supportsPromptCache: this.capabilities.model.metadata.getModelSupportsPromptCache?.(requestProvider, requestModel),
      permissionMode: this.config.permissionMode,
      runMode: this.config.runMode ?? "agent",
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages: cloneMessages(requestMessages),
      tools,
      maxMessages: this.config.maxContextMessages,
      customSystemPrompt: this.config.systemPrompt,
      appendSystemPrompt: joinSystemPromptAddenda(
        this.config.appendSystemPrompt,
        this.config.permissionMode === "plan" ? this.config.planModeInstructions : undefined,
        planTodo?.buildPromptAddendum(),
      ),
      abortSignal: input.abortSignal,
    };
  }

  private createBudgetPreparation(
    messages: CanonicalMessage[],
    input: AgentLoopInput,
  ): Omit<AgentContextPrepareInput, "abortSignal"> {
    const { abortSignal: _abortSignal, ...preparation } = this.createContextPrepareInput(messages, input);
    return preparation;
  }

  private budgetCalibrationFor(provider: string | undefined, model: string | undefined): TokenCalibrationBaseline | undefined {
    return provider && model ? this.tokenCalibrationByRoute.get(tokenCalibrationKey(provider, model)) : undefined;
  }

  private async estimateUsageCost(
    usage: CanonicalUsage | undefined,
    provider: string,
    model: string,
  ): Promise<number | undefined> {
    const routerEstimate = await this.capabilities.model.budget?.estimateUsageCost?.(usage, provider, model);
    if (typeof routerEstimate === "number" && Number.isFinite(routerEstimate) && routerEstimate >= 0) {
      return routerEstimate;
    }
    const nativeCost = usage?.nativeCost;
    return typeof nativeCost === "number" && Number.isFinite(nativeCost) && nativeCost >= 0
      ? nativeCost
      : undefined;
  }

  /**
   * Provider usage is preferred. When a budgeted invocation has no usage
   * payload, reuse the existing token-accounting estimator so the Gateway
   * still has a conservative cost basis before it permits another action.
   */
  private resolveBudgetUsage(
    usage: CanonicalUsage | undefined,
    estimatedInputTokens: number | undefined,
    assistantMessage: CanonicalMessage,
  ): CanonicalUsage | undefined {
    if (usage && Object.values(usage).some((value) => typeof value === "number" && Number.isFinite(value))) {
      return usage;
    }
    const responseText = assistantMessage.content.map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "tool_call") return typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
      return "";
    }).join("\n");
    const outputTokens = countTokens(responseText);
    if (estimatedInputTokens === undefined && outputTokens === 0) return usage;
    return {
      ...(estimatedInputTokens !== undefined ? { inputTokens: estimatedInputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      totalTokens: (estimatedInputTokens ?? 0) + outputTokens,
    };
  }

  private createBudgetEvaluator(
    input: AgentLoopInput,
    options: {
      decision?: { provider: string; model: string };
      baseRequest?: CanonicalModelRequest;
      prepared?: PreparedModelInvocation;
      maxContextTokens?: number;
      reservedOutputTokens: number;
    },
  ): CompactionBudgetEvaluator | undefined {
    const tokenAccounting = this.capabilities.model.budget;
    const evaluateRequestBudget = tokenAccounting?.evaluateRequestBudget;
    const maxContextTokens = options.maxContextTokens;
    if (!evaluateRequestBudget || !maxContextTokens) {
      return undefined;
    }
    let lastObservation: ReturnType<NonNullable<CompactionBudgetEvaluator["getLastObservation"]>>;
    const evaluator: CompactionBudgetEvaluator = async (candidateMessages) => {
      const candidateRequest = await this.createBudgetRequest(input, candidateMessages, options);
      const calibration = this.tokenCalibrationByRoute.get(tokenCalibrationKey(
        candidateRequest.provider,
        candidateRequest.model,
      ));
      const snapshot = await evaluateRequestBudget.call(tokenAccounting, candidateRequest, {
        maxContextTokens,
        reservedOutputTokens: options.reservedOutputTokens,
        signal: input.abortSignal,
        calibration,
      });
      lastObservation = {
        request: structuredClone(candidateRequest),
        maxContextTokens,
        reservedOutputTokens: options.reservedOutputTokens,
        ...(calibration ? { calibration: structuredClone(calibration) } : {}),
      };
      return snapshot;
    };
    evaluator.getLastObservation = () => lastObservation && structuredClone(lastObservation);
    return evaluator;
  }

  private async createBudgetRequest(
    input: AgentLoopInput,
    candidateMessages: CanonicalMessage[],
    options: {
      decision?: { provider: string; model: string };
      baseRequest?: CanonicalModelRequest;
      prepared?: PreparedModelInvocation;
      maxContextTokens?: number;
      reservedOutputTokens: number;
    },
  ): Promise<CanonicalModelRequest> {
    let candidateRequest = await this.createModelRequest(candidateMessages, input, {
      emitInstructionEvents: false,
      previewOnly: true,
    });
    if (options.prepared && options.baseRequest) {
      const materializedRequest = {
        ...options.baseRequest,
        messages: candidateRequest.messages,
        systemPrompt: candidateRequest.systemPrompt,
        tools: candidateRequest.tools,
        cacheBreakpoints: candidateRequest.cacheBreakpoints,
        cachePlan: candidateRequest.cachePlan,
      };
      candidateRequest = await this.materializePreparedRequest(options.prepared, materializedRequest);
    } else if (options.decision) {
      candidateRequest = {
        ...candidateRequest,
        provider: options.decision.provider,
        model: options.decision.model,
      };
    }
    return candidateRequest;
  }

  private async materializePreparedRequest(
    prepared: PreparedModelInvocation,
    candidate: CanonicalModelRequest,
  ): Promise<CanonicalModelRequest> {
    const routedCandidate = {
      ...candidate,
      provider: prepared.provider,
      model: prepared.model,
    };
    if (this.capabilities.model.routing?.materializeRequest) {
      return await this.capabilities.model.routing.materializeRequest(prepared, routedCandidate);
    }
    // A prepared execution port owns all provider-specific request controls.
    // Compaction only replaces the canonical message window; replacing the
    // prompt, tools, cache plan, or output cap here would undo preparation.
    return {
      ...prepared.request,
      messages: routedCandidate.messages,
      cacheBreakpoints: routedCandidate.cacheBreakpoints,
      cachePlan: routedCandidate.cachePlan,
      provider: prepared.provider,
      model: prepared.model,
    };
  }

  private recordTokenCalibration(
    request: CanonicalModelRequest,
    usage: CanonicalUsage | undefined,
    estimatedInputTokens: number | undefined,
  ): void {
    const actualInputTokens = actualInputTokensFromUsage(usage);
    if (actualInputTokens === undefined || estimatedInputTokens === undefined || estimatedInputTokens <= 0) {
      return;
    }
    this.tokenCalibrationByRoute.set(tokenCalibrationKey(request.provider, request.model), {
      provider: request.provider,
      model: request.model,
      actualInputTokens,
      estimatedInputTokens,
    });
  }

  private getReservedOutputTokens(provider?: string, model?: string): number {
    if (provider && model) {
      return this.currentMaxOutputTokens(provider, model) ?? 0;
    }
    return this.currentMaxOutputTokens(this.config.provider, this.config.model) ?? 0;
  }

  private tokenCapKey(provider: string, model: string): string {
    return tokenCalibrationKey(provider, model);
  }

  private getModelTokenLimits(provider: string, model: string): { maxContextTokens?: number; maxOutputTokens?: number } | undefined {
    const combined = this.capabilities.model.metadata.getModelTokenLimits?.(provider, model);
    if (combined) return combined;
    const maxContextTokens = this.capabilities.model.metadata.getModelMaxContextTokens?.(provider, model);
    const maxOutputTokens = this.capabilities.model.metadata.getModelMaxOutputTokens?.(provider, model);
    if (maxContextTokens === undefined && maxOutputTokens === undefined) return undefined;
    return { maxContextTokens, maxOutputTokens };
  }

  private currentMaxContextTokens(provider: string, model: string): number {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model))?.maxContextTokens;
    return transient
      ?? this.getBaselineSubagentTokenLimits(provider, model)?.maxContextTokens
      ?? this.currentConfigMaxContextTokens()
      ?? this.capabilities.model.metadata.getModelMaxContextTokens?.(provider, model)
      ?? this.getModelTokenLimits(provider, model)?.maxContextTokens
      ?? 1_000_000;
  }

  private preRoutingMaxContextTokens(): number {
    if (this.config.isSubagent && this.config.subagentModel) {
      return 1_000_000;
    }
    return this.currentMaxContextTokens(this.config.provider, this.config.model);
  }

  private currentMaxOutputTokens(provider: string, model: string): number | undefined {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model));
    const modelMaxOutputTokens = this.getModelTokenLimits(provider, model)?.maxOutputTokens;
    const requested = transient?.attemptMaxOutputTokens
      ?? transient?.requestedMaxOutputTokens
      ?? transient?.sessionMaxOutputTokens
      ?? this.getBaselineSubagentTokenLimits(provider, model)?.maxOutputTokens
      ?? this.currentConfigMaxOutputTokens();
    const candidates = [requested, transient?.hardMaxOutputTokens]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    if (candidates.length > 0 && typeof modelMaxOutputTokens === "number" && Number.isFinite(modelMaxOutputTokens) && modelMaxOutputTokens > 0) {
      candidates.push(modelMaxOutputTokens);
    }
    return candidates.length > 0 ? Math.min(...candidates.map((value) => Math.floor(value))) : undefined;
  }

  private getBaselineSubagentTokenLimits(provider: string, model: string): { maxContextTokens?: number; maxOutputTokens?: number } | undefined {
    if (this.config.isSubagent !== true) {
      return undefined;
    }
    const baseline = this.config.subagentModel;
    if (!baseline || baseline.provider !== provider || baseline.model !== model) {
      return undefined;
    }
    return {
      maxContextTokens: baseline.maxContextTokens,
      maxOutputTokens: baseline.maxOutputTokens,
    };
  }

  private currentConfigMaxContextTokens(): number | undefined {
    if (this.config.isSubagent && this.config.subagentModel) {
      return undefined;
    }
    return this.config.maxContextTokens;
  }

  private currentConfigMaxOutputTokens(): number | undefined {
    if (this.config.isSubagent && this.config.subagentModel) {
      return undefined;
    }
    return this.config.maxOutputTokens;
  }

  private setTransientTokenCap(provider: string, model: string, cap: AgentLoopTokenCap): void {
    const key = this.tokenCapKey(provider, model);
    const previous = this.transientTokenCaps.get(key) ?? {};
    this.transientTokenCaps.set(key, { ...previous, ...cap });
  }

  private clearAttemptOutputTokenCap(provider: string, model: string): void {
    const key = this.tokenCapKey(provider, model);
    const previous = this.transientTokenCaps.get(key);
    if (!previous || previous.attemptMaxOutputTokens === undefined) return;
    const { attemptMaxOutputTokens: _attemptMaxOutputTokens, ...rest } = previous;
    this.transientTokenCaps.set(key, rest);
  }

  private clearTurnScopedTokenCaps(): void {
    for (const [key, cap] of this.transientTokenCaps) {
      const {
        requestedMaxOutputTokens: _requestedMaxOutputTokens,
        attemptMaxOutputTokens: _attemptMaxOutputTokens,
        ...sessionCaps
      } = cap;
      if (sessionCaps.maxContextTokens === undefined
        && sessionCaps.sessionMaxOutputTokens === undefined
        && sessionCaps.hardMaxOutputTokens === undefined) {
        this.transientTokenCaps.delete(key);
      } else {
        this.transientTokenCaps.set(key, sessionCaps);
      }
    }
  }

  private async persistCompactSnapshot(
    input: AgentLoopInput,
    compact: Extract<Awaited<ReturnType<NonNullable<AgentTurnContextPort["tryAutoCompact"]>>>, { type: "compacted" }>,
  ): Promise<void> {
    if (!input.onCompactPersisted || !compact.result) {
      return;
    }
    const boundary: AgentControlBoundaryTranscriptEntry["boundary"] = {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        compactionId: compact.result.compactionId,
        trigger: compact.result.trigger,
        preTokens: compact.result.preTokens,
        postTokens: compact.snapshot.tokens,
        messagesSummarized: compact.result.messagesSummarized,
        ...(compact.result.targetPostTokens !== undefined ? { targetTokens: compact.result.targetPostTokens } : {}),
        summaryGenerated: compactionSummaryGenerated(compact.result),
        checkpointMerged: compact.result.checkpointMerged ?? compact.result.cacheReset === true,
        finalRatio: compact.snapshot.ratio,
        extra: {
          tier: compact.tier,
          summarySucceeded: compactionSummarySucceeded(compact.result),
          ...(compact.result.cacheReset ? { cacheReset: true } : {}),
          ...(compact.error
            ? {
                finalBudgetTokens: compact.snapshot.maxContextTokens,
                finalUsedTokens: compact.snapshot.tokens,
                finalBudgetRatio: compact.snapshot.ratio,
              }
            : {}),
          ...(compact.error ? { error: compact.error } : {}),
        },
      },
    };
    try {
      await input.onCompactPersisted({
        boundary,
        messages: markCompactReplacementMessages(compact.messages, compact.result.compactionId),
      });
    } catch (error) {
      throw new CompactionPersistenceError(error);
    }
  }

  private applyTokenCapsToRequest(request: CanonicalModelRequest, provider: string, model: string): CanonicalModelRequest {
    const maxOutputTokens = this.currentMaxOutputTokens(provider, model);
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model));
    // A provider-directed retry cap is an explicit attempt override. The
    // session recovery target only establishes the default for requests that
    // do not already carry a prepared cap; it must not enlarge an adapter's
    // deliberate smaller request cap on a normal turn.
    const attemptOverride = transient?.attemptMaxOutputTokens
      ?? transient?.requestedMaxOutputTokens;
    const preparedCap = request.maxOutputTokens;
    const effectiveMaxOutputTokens = attemptOverride === undefined
      && typeof preparedCap === "number" && Number.isFinite(preparedCap) && preparedCap > 0
      && maxOutputTokens !== undefined
      ? Math.min(maxOutputTokens, Math.floor(preparedCap))
      : maxOutputTokens ?? preparedCap;
    return {
      ...request,
      provider,
      model,
      ...(effectiveMaxOutputTokens !== undefined ? { maxOutputTokens: effectiveMaxOutputTokens } : {}),
    };
  }

  private createToolContext(input: AgentLoopInput): PilotDeckToolRuntimeContext {
    const planDirectoryPath = this.capabilities.planMode.planFileManager?.getPlanDirectoryPath();
    const planTodo = this.capabilities.planMode.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const permissionContext = {
      ...this.config.permissionContext,
      cwd: this.config.cwd,
      canPrompt,
      ...(planDirectoryPath ? { planDirectoryPath } : {}),
    };
    const auxiliaryModel = this.capabilities.model.auxiliary?.forTurn?.({
      sessionId: input.sessionId,
      turnId: input.turnId,
      projectPath: this.config.cwd,
    }) ?? this.capabilities.model.auxiliary;
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      // Group key for `FileHistoryStore.trackEdit` (C4). Our canonical
      // assistant messages don't carry an id, so the turn id is the closest
      // stable scope: every edit/write produced inside this turn rewinds as
      // a single batch — semantic match to legacy "rewind by messageId".
      messageId: input.turnId,
      cwd: this.config.cwd,
      abortSignal: input.abortSignal,
      subagentTimeoutMs: this.config.subagentTimeoutMs,
      toolAliases: this.config.toolAliases,
      runMode: this.config.runMode ?? "agent",
      permissionMode: this.config.permissionMode,
      permissionContext,
      canElicit: input.canElicit === true && this.capabilities.interaction.elicitationAvailable === true,
      auditRecorder: this.capabilities.toolExecution.auditRecorder,
      now: this.now,
      env: buildTurnEnvironment(
        this.config.env,
        this.config.cwd,
        input.sessionId,
        input.turnId,
      ),
      maxResultBytes: this.config.maxResultBytes,
      ...(this.config.includeToolProgress === true && this.capabilities.events.emit
        ? {
            progress: (event: import("../../tool/index.js").PilotDeckToolProgressEvent) => {
              this.capabilities.events.emit?.({
                type: "tool_progress",
                sessionId: input.sessionId,
                turnId: input.turnId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                message: event.message,
                ...(event.metadata ? { metadata: event.metadata } : {}),
                createdAt: event.createdAt,
              });
            },
          }
        : {}),
      // Tools that need a secondary model call (e.g. `agent` subagents in
      // fallback mode, `web_fetch` extraction) get a thin adapter that
      // funnels into the router's stream so subagents inherit fallback /
      // zero-usage retry.
      ...(auxiliaryModel ? { model: auxiliaryModel } : {}),
      elicitation: this.capabilities.interaction.elicitation,
      userDialog: this.capabilities.interaction.userDialog,
      fileHistory: this.capabilities.toolExecution.fileHistory,
      subagentDepth: this.config.subagentDepth ?? 0,
      ...(this.capabilities.subagent.oneShot ? {
        subagent: this.capabilities.subagent.oneShot.createForkApi({
          sessionId: input.sessionId,
          turnId: input.turnId,
          workspaceId: input.workspaceId,
          storageConfigVersion: input.storageConfigVersion,
          invocationLogSink: input.invocationLogSink,
          parentReadFileState: this.readFileState,
          parentWriteSnapshots: this.writeSnapshots,
        }),
      } : {}),
      modelMultimodal: this.config.modelMultimodal,
      maxOutputTokens: this.config.maxOutputTokens,
      readFileState: this.readFileState,
      allowedReadFiles: [...this.allowedReadFiles],
      writeSnapshots: this.writeSnapshots,
      fileUpdateNotifier: this.capabilities.toolExecution.fileUpdateNotifier,
      ...(planTodo ? { planTodo } : {}),
      ...(this.capabilities.goal ? { goal: this.capabilities.goal.forSession(input.sessionId) } : {}),
      ...(planDirectoryPath
        ? {
            planDirectory: {
              path: planDirectoryPath,
              resolve: (filePath: string) =>
                this.capabilities.planMode.planFileManager?.resolvePlanFilePath(filePath, this.config.cwd),
              read: (filePath: string) =>
                this.capabilities.planMode.planFileManager?.readPlanFile(filePath, this.config.cwd),
            },
          }
        : {}),
    };
  }

  private async dispatchLifecycle(
    input: AgentLoopInput,
    event: PilotDeckHookEvent,
    payload: Record<string, unknown>,
  ): Promise<LifecycleDispatchResult> {
    return this.capabilities.hooks.lifecycle?.dispatch({
      event,
      baseInput: {
        sessionId: input.sessionId,
        transcriptPath: "",
        cwd: this.config.cwd,
        permissionMode: this.config.permissionMode,
      },
      payload,
      matchQuery: event,
      signal: input.abortSignal,
      env: buildTurnEnvironment(
        this.config.env,
        this.config.cwd,
        input.sessionId,
        input.turnId,
      ),
    }) ?? {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }

  /** Keep compaction progress live while its summary model request is pending. */
  private async *awaitCompactionWithEvents<T>(operation: Promise<T>): AsyncGenerator<AgentEvent, T, unknown> {
    let settled = false;
    const completion = operation.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });
    while (!settled) {
      yield* this.drainEventBuffer();
      await Promise.race([completion, sleep(TOOL_EVENT_PUMP_INTERVAL_MS)]);
    }
    yield* this.drainEventBuffer();
    const result = await completion;
    if (!result.ok) throw result.error;
    return result.value;
  }

  private *drainEventBuffer(): Generator<AgentEvent> {
    const events = this.capabilities.events.drain?.() ?? [];
    for (const event of events) {
      yield event;
    }
  }

  private async *executeToolsWithEventPump(
    toolCalls: CanonicalToolCall[],
    context: PilotDeckToolRuntimeContext,
    input: AgentLoopInput,
    runId: string,
  ): AsyncGenerator<AgentEvent, PilotDeckToolResult[], unknown> {
    const activeSubagents = new Map<string, ActiveSubagentStatus>();
    let results: PilotDeckToolResult[] | undefined;
    let error: unknown;
    let settled = false;

    const executionContext: AgentExecutionContext = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId,
      operationDeadline: input.execution?.operationDeadline,
      abortSignal: input.abortSignal,
    };
    const execution = this.toolPort.executeAll(toolCalls, context, executionContext)
      .then((value) => {
        results = value;
      }, (err) => {
        error = err;
      })
      .finally(() => {
        settled = true;
      });

    while (!settled) {
      await Promise.race([execution, sleep(TOOL_EVENT_PUMP_INTERVAL_MS)]);
      yield* this.drainToolEventBufferForSubagentStatus(input, activeSubagents);
      if (!settled) {
        yield* this.emitSubagentHeartbeats(input, activeSubagents);
      }
    }

    yield* this.drainToolEventBufferForSubagentStatus(input, activeSubagents);
    if (error) throw error;
    const completed = results ?? [];
    await this.capabilities.toolResultObserver?.onToolResults({
      sessionId: input.sessionId,
      turnId: input.turnId,
      results: completed,
    });
    return completed;
  }

  private *drainToolEventBufferForSubagentStatus(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const events = this.capabilities.events.drain?.() ?? [];
    for (const event of events) {
      const statusEvent = this.updateSubagentStatusFromEvent(input, activeSubagents, event);
      yield event;
      if (statusEvent) {
        yield statusEvent;
      }
    }
  }

  private updateSubagentStatusFromEvent(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
    event: AgentEvent,
  ): AgentEvent | undefined {
    if (event.type === "subagent_started") {
      const nowMs = this.now().getTime();
      activeSubagents.set(event.subagentId, {
        subagentId: event.subagentId,
        subagentType: event.subagentType,
        startedAtMs: nowMs,
        lastHeartbeatMs: nowMs,
      });
      return undefined;
    }

    if (event.type === "subagent_completed") {
      activeSubagents.delete(event.subagentId);
      return undefined;
    }

    if (event.type !== "pre_tool_execute" && event.type !== "post_tool_execute") {
      return undefined;
    }

    const subagentId = subagentIdFromSessionId(event.sessionId);
    if (!subagentId) {
      return undefined;
    }

    const nowMs = this.now().getTime();
    const state = activeSubagents.get(subagentId) ?? {
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
    activeSubagents.set(subagentId, state);

    return {
      type: "subagent_status",
      sessionId: input.sessionId,
      turnId: input.turnId,
      subagentId,
      subagentType: state.subagentType,
      status: event.type === "pre_tool_execute" ? "tool_started" : "tool_completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "post_tool_execute" ? { success: event.success } : {}),
      durationMs: Math.max(0, nowMs - state.startedAtMs),
    };
  }

  private *emitSubagentHeartbeats(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const nowMs = this.now().getTime();
    for (const state of activeSubagents.values()) {
      if (nowMs - state.lastHeartbeatMs < SUBAGENT_STATUS_HEARTBEAT_MS) {
        continue;
      }
      state.lastHeartbeatMs = nowMs;
      yield {
        type: "subagent_status",
        sessionId: input.sessionId,
        turnId: input.turnId,
        subagentId: state.subagentId,
        subagentType: state.subagentType,
        status: state.currentToolName ? "running" : "waiting_model",
        toolCallId: state.currentToolCallId,
        toolName: state.currentToolName,
        durationMs: Math.max(0, nowMs - state.startedAtMs),
      };
    }
  }

  private createTurnResult(
    input: AgentLoopInput,
    options: Omit<AgentTurnResult, "sessionId" | "turnId" | "completedAt">,
  ): AgentTurnResult {
    return {
      ...options,
      sessionId: input.sessionId,
      turnId: input.turnId,
      completedAt: this.now().toISOString(),
      ...(this.activeBudget ? {
        budget: {
          turnSpentUsd: this.activeBudget.turnSpentUsd,
          ...(this.activeBudget.taskBudgetUsd !== undefined ? {
            taskBudgetUsd: this.activeBudget.taskBudgetUsd,
            taskSpentUsd: this.activeBudget.initialTaskBudgetSpentUsd + this.activeBudget.turnSpentUsd,
          } : {}),
        },
      } : {}),
    };
  }

  private applyRunModeOverride(runMode?: AgentRunMode): void {
    if (runMode) {
      this.config.runMode = runMode;
    } else {
      this.config.runMode ??= "agent";
    }
  }

  private readonly now = (): Date => this.capabilities.clock.now?.() ?? new Date();
}

export { buildTurnEnvironment } from "../turn/TurnEnvironment.js";

function filterAskModeTools(tools: PilotDeckToolDefinition[]): CanonicalToolSchema[] {
  const agentOverride = buildAskModeAgentToolSchema();
  return tools
    .filter(isAskModeAllowedTool)
    .map((tool) => {
      if (tool.name === "agent") {
        return { ...toolToCanonicalSchema(tool), description: agentOverride.description, inputSchema: agentOverride.inputSchema };
      }
      const suffix = ASK_MODE_DESCRIPTION_SUFFIX[tool.name];
      const schema = toolToCanonicalSchema(tool);
      return suffix ? { ...schema, description: schema.description + suffix } : schema;
    });
}

function toolToCanonicalSchema(tool: PilotDeckToolDefinition): CanonicalToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function findLifecycleBlock(result: LifecycleDispatchResult): { reason: string; stopReason?: string } | undefined {
  return result.effects.find(
    (effect): effect is { type: "block"; reason: string; stopReason?: string } => effect.type === "block",
  );
}

function findToolLifecycleBlock(results: PilotDeckToolResult[]): { reason: string; stopReason?: string } | undefined {
  for (const result of results) {
    const lifecycle = result.metadata?.lifecycle;
    if (isRecord(lifecycle) && isRecord(lifecycle.blocked) && typeof lifecycle.blocked.reason === "string") {
      return {
        reason: lifecycle.blocked.reason,
        stopReason: typeof lifecycle.blocked.stopReason === "string" ? lifecycle.blocked.stopReason : undefined,
      };
    }
  }
  return undefined;
}

function textFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function withoutThinkingBlocks(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: messageContent(message).filter((block) => block.type !== "thinking"),
  };
}

function safeFinalTextMessage(
  message: CanonicalMessage,
  toolCalls: CanonicalToolCall[],
): CanonicalMessage | undefined {
  if (toolCalls.length > 0) {
    return undefined;
  }
  const textMessage = withoutThinkingBlocks(message);
  return textFromMessage(textMessage).trim().length > 0 ? textMessage : undefined;
}

function buildStreamInterruptionRecoveryPrompt(
  interruption: NonNullable<CanonicalModelError["streamInterruption"]>,
): string {
  if (interruption.phase === "tool_call") {
    const tools = interruption.activeToolCalls?.map((call) => call.name || "unknown").filter(Boolean) ?? [];
    const toolLabel = tools.length > 0 ? ` (${tools.slice(0, 3).join(", ")})` : "";
    return [
      `The previous model stream disconnected while generating a tool call${toolLabel}. No incomplete tool call was executed.`,
      "Continue the original task from the current workspace state. Inspect relevant files before writing.",
      "Do not retry the same large atomic write. Create or extend the artifact through small focused write_file or edit_file calls, keeping each tool call well under 8K output tokens.",
    ].join("\n");
  }
  if (interruption.phase === "reasoning") {
    return "The previous model stream disconnected during reasoning. Continue the original task directly from the current workspace state; do not repeat analysis or recap.";
  }
  if (interruption.phase === "text") {
    return "The previous model stream disconnected mid-response. Continue exactly where the visible response ended; do not repeat prior text or recap.";
  }
  return "The previous model stream disconnected before producing a response. Continue the original task directly from the current workspace state.";
}

function buildUnknownFinishRecoveryPrompt(toolCalls: CanonicalToolCall[]): string {
  if (toolCalls.length > 0) {
    return [
      "The previous response ended without a recognized finish reason after generating tool calls. No tool call was executed.",
      "Continue the original task from the current workspace state. Inspect relevant files before acting.",
      "Do not repeat the same large atomic write. Use small focused write_file or edit_file calls.",
    ].join("\n");
  }
  return "The previous response ended without a recognized finish reason. Continue exactly where the visible response ended; do not repeat prior text or recap.";
}

function isMissingReasoningContentError(error: CanonicalModelError): boolean {
  return /\breasoning_content\b/i.test(error.message) &&
    /thinking\s+mode/i.test(error.message) &&
    /pass(?:ed)?\s+back/i.test(error.message);
}

function addEmptyReasoningContentMarkers(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message, index) => {
    if (index === messages.length - 1 && message.role === "assistant" && messageContent(message).length === 0) {
      return message;
    }
    if (message.role !== "assistant" || hasReplayableReasoningContent(message)) {
      return message;
    }
    return {
      ...message,
      content: [
        { type: "thinking", text: "", reasoningContent: "" },
        ...messageContent(message),
      ],
    };
  });
}

function hasReplayableReasoningContent(message: CanonicalMessage): boolean {
  return messageContent(message).some((block) =>
    block.type === "thinking" &&
    ((block.reasoningContent ?? block.text).length > 0 || block.reasoningContent === "")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneReadFileStateMap(
  state: PilotDeckReadFileStateMap | undefined,
): PilotDeckReadFileStateMap {
  const out: PilotDeckReadFileStateMap = new Map();
  if (!state) return out;
  for (const [key, value] of state.entries()) {
    out.set(key, { ...value });
  }
  return out;
}

function cloneWriteSnapshotMap(
  state: PilotDeckWriteSnapshotMap | undefined,
): PilotDeckWriteSnapshotMap {
  const out: PilotDeckWriteSnapshotMap = new Map();
  if (!state) return out;
  for (const [key, value] of state.entries()) {
    out.set(key, { ...value });
  }
  return out;
}

function subagentIdFromSessionId(sessionId: string): string | undefined {
  const marker = "::sub::";
  const index = sessionId.lastIndexOf(marker);
  if (index < 0) return undefined;
  const subagentId = sessionId.slice(index + marker.length).trim();
  return subagentId.length > 0 ? subagentId : undefined;
}

/** Keep a bounded tail without dropping the user request that initiated it. */
function truncateHeadKeepRatio(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  return truncateHeadPreservingCheckpoint(messages, keepRatio);
}

function buildInvalidFingerprint(results: PilotDeckToolResult[]): string {
  return results
    .filter(
      (result): result is PilotDeckToolErrorResult =>
        result.type === "error" && result.error.code === "invalid_tool_input",
    )
    .map((result) => `${result.toolName}::${result.error.message}`)
    .sort()
    .join("\n");
}

/**
 * Drop the trailing `[assistant_message_with_partial_tool_call,
 * synthetic_tool_result]` pair the loop just appended on a model error so a
 * retry doesn't replay an unfinished tool call. Safe no-op if the trailing
 * shape doesn't match.
 */
function stripTrailingErrorPair(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (
    last &&
    last.role === "user" &&
    last.content.every((block) => block.type === "tool_result")
  ) {
    out.pop();
  }
  const newLast = out[out.length - 1];
  if (newLast && newLast.role === "assistant") {
    out.pop();
  }
  return out;
}

/**
 * Strip all image blocks from messages, replacing them with a text placeholder.
 * Used as a recovery strategy when a multimodal processor fails on corrupted images.
 */
function stripImagesFromMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((msg) => {
    const newContent = msg.content.map((block) => {
      if (block.type === "image") {
        return { type: "text" as const, text: "[Image removed: multimodal processor error recovery]" };
      }
      if (block.type === "tool_result" && block.content.some((c) => c.type === "image")) {
        return {
          ...block,
          content: block.content.map((c) =>
            c.type === "image"
              ? { type: "text" as const, text: "[Image removed: multimodal processor error recovery]" }
              : c,
          ),
        };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}

function removeTransientPromptsById(
  messages: CanonicalMessage[],
  transientIds: Set<string>,
): CanonicalMessage[] {
  return messages.filter((message) => {
    const transientId = message.metadata?.transientId;
    return !(
      message.role === "user" &&
      message.metadata?.transient === true &&
      typeof transientId === "string" &&
      transientIds.has(transientId)
    );
  });
}


function detectRepeatedToolFailure(
  results: PilotDeckToolResult[],
  lastFingerprint: string | undefined,
): {
  currentFingerprint?: string;
  repeatedKeys: Set<string>;
} {
  const keys = buildToolFailureKeys(results);
  const fingerprint = keys.length > 0 ? keys.join("\n") : undefined;
  const repeatedKeys = findRepeatedValues(keys);
  if (fingerprint && fingerprint === lastFingerprint) {
    for (const key of keys) {
      repeatedKeys.add(key);
    }
  }
  if (!fingerprint) {
    return { repeatedKeys };
  }
  return {
    currentFingerprint: fingerprint,
    repeatedKeys,
  };
}

function buildToolFailureKeys(results: PilotDeckToolResult[]): string[] {
  return results
    .filter((result): result is PilotDeckToolErrorResult => result.type === "error")
    .map((result) => {
      const recovery = readRecoveryMetadata(result);
      return toolFailureKey(result, recovery);
    })
    .sort();
}

function annotateRepeatedToolFailures(
  results: PilotDeckToolResult[],
  repeatedKeys: Set<string>,
): PilotDeckToolResult[] {
  if (repeatedKeys.size === 0) {
    return results;
  }

  return results.map((result) => {
    if (result.type !== "error") {
      return result;
    }
    const recovery = readRecoveryMetadata(result);
    if (!repeatedKeys.has(toolFailureKey(result, recovery))) {
      return result;
    }
    const avoidRetryReason = typeof recovery?.avoidRetryReason === "string"
      ? recovery.avoidRetryReason
      : "The same tool, error code, and recovery class repeated. Retrying unchanged is likely to fail again.";
    const repeatedText =
      `\n\nRepeated failure: ${avoidRetryReason}\n` +
      "Change at least one of the tool, parameters, path, scope, permission path, or explain the blocker in text.";
    return {
      ...result,
      content: appendTextToFirstContent(result.content, repeatedText),
      metadata: {
        ...(result.metadata ?? {}),
        recovery: recovery
          ? {
              ...recovery,
              avoidRetryReason,
              repeatedFailure: true,
            }
          : {
              avoidRetryReason,
              repeatedFailure: true,
            },
      },
    };
  });
}

function toolFailureKey(
  result: PilotDeckToolErrorResult,
  recovery: Record<string, unknown> | undefined,
): string {
  return `${result.toolName}::${result.error.code}::${recovery?.failureClass ?? "unknown"}`;
}

function findRepeatedValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    } else {
      seen.add(value);
    }
  }
  return repeated;
}

function appendTextToFirstContent(
  content: PilotDeckToolErrorResult["content"],
  suffix: string,
): PilotDeckToolErrorResult["content"] {
  const [first, ...rest] = content;
  if (!first) {
    return [{ type: "text", text: suffix.trimStart() }];
  }
  if (first.type !== "text") {
    return [{ type: "text", text: suffix.trimStart() }, first, ...rest];
  }
  return [{ ...first, text: `${first.text}${suffix}` }, ...rest];
}

function readRecoveryMetadata(result: PilotDeckToolErrorResult): Record<string, unknown> | undefined {
  const recovery = result.metadata?.recovery;
  return isRecord(recovery) ? recovery : undefined;
}

function collectPermissionDenials(results: PilotDeckToolResult[]): AgentPermissionDenial[] {
  return results.flatMap((result) => {
    if (
      result.type === "error" &&
      (result.error.code === "permission_denied" ||
        result.error.code === "permission_required" ||
        result.error.code === "permission_cancelled")
    ) {
      return [
        {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          errorCode: result.error.code,
        },
      ];
    }
    return [];
  });
}

function mergeUsage(first: CanonicalUsage, second: CanonicalUsage | undefined): CanonicalUsage {
  if (!second) {
    return first;
  }
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
    nativeCost: add(first.nativeCost, second.nativeCost),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

function readRequestedMode(value: unknown): AgentRuntimeConfig["permissionMode"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const requestedMode = (value as Record<string, unknown>).requestedMode;
  return isPermissionMode(requestedMode) ? requestedMode : undefined;
}

function bindSupplementalMessagesToToolCalls(
  results: PilotDeckToolResult[],
  supplementalMessages: CanonicalMessage[],
): ContextSupplementalToolResultMessage[] {
  const bound: ContextSupplementalToolResultMessage[] = [];
  let index = 0;
  for (const result of results) {
    const count = result.supplementalMessages?.length ?? 0;
    for (let offset = 0; offset < count && index < supplementalMessages.length; offset += 1) {
      bound.push({ toolCallId: result.toolCallId, message: supplementalMessages[index] });
      index += 1;
    }
  }
  return bound;
}

function isPermissionMode(value: unknown): value is AgentRuntimeConfig["permissionMode"] {
  return (
    value === "default" ||
    value === "plan" ||
    value === "bypassPermissions"
  );
}

function classifyModelError(error: CanonicalModelError): {
  stopReason: AgentTurnResult["stopReason"];
  error: ReturnType<typeof agentError>;
} {
  if (isPromptTooLong(error)) {
    return {
      stopReason: "prompt_too_long",
      error: agentError(
        "agent_prompt_too_long",
        error.message,
        error,
        error.userHint ?? "Input exceeds the model context window. Try /compact to compress history or /new for a fresh session.",
      ),
    };
  }
  return {
    stopReason: "model_error",
    error: agentError("agent_model_error", error.message, error, error.userHint),
  };
}

function createModelRequestFailedStatus(args: {
  error: ReturnType<typeof agentError>;
  modelError?: CanonicalModelError;
}): AgentStatusMessage {
  const providerMessage = args.error.message || args.modelError?.message || "The model request failed, so this turn has stopped.";
  const text = formatModelRequestFailureMessage(providerMessage, args.modelError);
  const action = modelFailureAction(args.modelError);
  return {
    event: "model_request_failed",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: {
        key: "chat:agentStatus.modelRequestFailed.message",
        params: { providerMessage },
      },
      code: args.error.code,
      userHint: action.userHint,
      userHintI18n: action.userHintI18n,
      detail: {
        provider: args.modelError?.provider,
        protocol: args.modelError?.protocol,
        status: args.modelError?.status,
        modelErrorCode: args.modelError?.code,
        retryable: args.modelError?.retryable,
        providerMessage,
        settingsFix: args.modelError?.settingsFix,
        fixTarget: action.fixTarget,
      },
    }),
  };
}

export function formatModelRequestFailureMessage(providerMessage: string, error: CanonicalModelError | undefined): string {
  const cleanMessage = providerMessage.trim() || "The model request failed.";
  const action = modelFailureAction(error);
  return `${cleanMessage}\n\n${action.shortAction}`;
}

export function modelFailureAction(error: CanonicalModelError | undefined): {
  shortAction: string;
  userHint: string;
  userHintI18n: AgentStatusI18nDescriptor;
  fixTarget: "settings" | "provider" | "network" | "prompt" | "retry";
} {
  if (!error) {
    const hint = "Check Settings → Model Provider and verify the selected provider, base URL, API key, model name, and timeoutMs. If the provider is slow or the network is unstable, increase timeoutMs or check provider status.";
    return modelFailureActionResult(hint, "settings", "settingsDefault");
  }

  const providerLabel = error.provider ? ` provider "${error.provider}"` : " provider";
  const modelLabel = error.model ? ` model "${error.model}"` : " selected model";

  if (error.status === 401 || error.status === 403 || error.code === "auth_error") {
    const hint = `Update the API key or access permissions for${providerLabel} in Settings → Model Provider, or run pilotdeck setup.`;
    return modelFailureActionResult(hint, "settings", "auth", { provider: error.provider ?? "the provider" });
  }
  if (error.code === "model_not_found") {
    const hint = `Choose a valid${modelLabel} for${providerLabel} in Settings → Model Provider, or add it under model.providers.<id>.models in pilotdeck.yaml.`;
    return modelFailureActionResult(hint, "settings", "modelNotFound", { provider: error.provider ?? "the provider", model: error.model });
  }
  if (error.code === "timeout") {
    if (error.settingsFix?.configPath === "model.providers.<id>.retry.streamIdleTimeoutMs") {
      const hint = `Increase streamIdleTimeoutMs for${providerLabel} in Settings → Advanced, or check local network/proxy and provider status.`;
      return modelFailureActionResult(hint, "network", "streamIdleTimeout", { provider: error.provider ?? "the provider" });
    }
    const hint = `Increase timeoutMs for${providerLabel} in Settings → Model Provider → Advanced, or check local network/proxy and provider status.`;
    return modelFailureActionResult(hint, "network", "timeout", { provider: error.provider ?? "the provider" });
  }
  if (error.status === 429 || error.code === "rate_limit_error") {
    const hint = `Wait for the provider rate limit to reset, reduce concurrency, or switch to another provider/model in Settings.`;
    return modelFailureActionResult(hint, "provider", "rateLimit");
  }
  if (error.code === "billing") {
    const hint = `Top up billing/quota on the provider API side, or switch to another provider/model in Settings.`;
    return modelFailureActionResult(hint, "provider", "billing");
  }
  if (
    error.code === "prompt_too_long"
    || error.code === "context_overflow"
    || error.code === "context_overflow_after_emergency_compaction"
  ) {
    const hint = "Run /compact, start a new session, remove large attachments, or switch to a larger-context model in Settings.";
    return modelFailureActionResult(hint, "prompt", "contextOverflow");
  }
  if (error.code === "payload_too_large" || error.code === "request_too_large") {
    const hint = "Reduce attachments/context size, run /compact, or start a new session before retrying.";
    return modelFailureActionResult(hint, "prompt", "payloadTooLarge");
  }
  if (error.code === "max_output_reached") {
    const hint = "Increase max output tokens in Settings → Model Provider, or ask the agent to split the answer into smaller parts.";
    return modelFailureActionResult(hint, "settings", "maxOutput");
  }
  if (error.code === "image_too_large") {
    const hint = "Resize or remove large images, then retry.";
    return modelFailureActionResult(hint, "prompt", "imageTooLarge");
  }
  if (error.retryable || error.code === "server_error" || error.code === "overloaded_error") {
    const hint = `Retry later, check provider API status, or switch to another provider/model in Settings if it repeats.`;
    return modelFailureActionResult(hint, "provider", "providerRetry");
  }

  const hint = `Check Settings → Model Provider for base URL/API key/model and timeoutMs. If settings look correct, check local network/proxy and provider API status/logs.`;
  return modelFailureActionResult(hint, "settings", "settingsDefault");
}

function modelFailureActionResult(
  hint: string,
  fixTarget: "settings" | "provider" | "network" | "prompt" | "retry",
  key: string,
  params: Record<string, unknown> = {},
): {
  shortAction: string;
  userHint: string;
  userHintI18n: AgentStatusI18nDescriptor;
  fixTarget: "settings" | "provider" | "network" | "prompt" | "retry";
} {
  return {
    shortAction: `Action: ${hint}`,
    userHint: hint,
    userHintI18n: { key: `chat:agentStatus.modelRequestFailed.actions.${key}`, params },
    fixTarget,
  };
}

function createToolCallRecoveryExhaustedStatus(args: {
  error: ReturnType<typeof agentError>;
  attempts?: number;
  reason?: string;
}): AgentStatusMessage {
  const text = args.error.message || "Tool-call recovery was exhausted, so this turn has stopped.";
  return {
    event: "tool_call_recovery_exhausted",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.toolCallRecoveryExhausted.message", params: { message: text } },
      code: args.error.code,
      userHint: args.error.userHint ?? "Retry with a shorter prompt, ask the agent to split large tool inputs into smaller steps, or switch to a model with stronger tool-calling support in Settings → Model Provider.",
      userHintI18n: { key: "chat:agentStatus.toolCallRecoveryExhausted.hint" },
      detail: {
        attempts: args.attempts,
        reason: args.reason,
      },
    }),
  };
}

function createToolErrorLoopStatus(args: {
  error: ReturnType<typeof agentError>;
  repeatedFailures?: number;
}): AgentStatusMessage {
  const text = args.error.message || "The agent repeatedly hit the same tool error, so this turn has stopped.";
  return {
    event: "tool_error_loop",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      code: args.error.code,
      userHint: args.error.userHint ?? "Change the request to avoid repeating the same failing tool call, grant any required permission, or switch to a model with stronger tool-calling support in Settings → Model Provider.",
      detail: {
        repeatedFailures: args.repeatedFailures,
      },
    }),
  };
}

function createLifecycleBlockedStatus(args: {
  error: ReturnType<typeof agentError>;
  stage: string;
}): AgentStatusMessage {
  const text = args.error.message || "A lifecycle hook blocked this turn.";
  return {
    event: "lifecycle_blocked",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      code: args.error.code,
      userHint: args.error.userHint ?? "Review the blocking lifecycle hook output or disable the hook, then retry.",
      detail: {
        stage: args.stage,
      },
    }),
  };
}

function defaultModelFailureHint(error: CanonicalModelError | undefined): string {
  if (!error) {
    return "Check the model provider settings and retry.";
  }
  if (error.retryable) {
    return "The provider marked this error as retryable. Retry the turn; if it repeats, check provider status and rate limits.";
  }
  if (error.status === 401 || error.status === 403 || error.code === "auth_error") {
    return "Check the provider API key and model access settings.";
  }
  if (error.status === 429 || error.code === "rate_limit_error") {
    return "Wait for the rate limit to reset or switch to another provider/model.";
  }
  if (error.code === "billing") {
    return "Check the provider billing or quota settings.";
  }
  return "Check the provider/model settings and retry.";
}

function createEmptyResponseStatus(args: {
  provider?: string;
  model?: string;
  attempts: number;
}): AgentStatusMessage {
  const text = "The model returned empty content repeatedly, so this turn has stopped. Try again later or increase max output tokens.";
  return {
    event: "model_empty_response_exhausted",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.emptyResponse.message" },
      code: "model_empty_response_exhausted",
      userHint: "Increase max output tokens in Settings → Model Provider, retry with a shorter prompt, or check whether this provider/model supports the requested output format.",
      userHintI18n: { key: "chat:agentStatus.emptyResponse.hint" },
      detail: {
        provider: args.provider,
        model: args.model,
        attempts: args.attempts,
      },
    }),
  };
}

function createMaxTurnsStatus(args: {
  maxTurns: number;
  error: ReturnType<typeof agentError>;
}): AgentStatusMessage {
  const text = `Reached the maximum number of turns (${args.maxTurns}), so this turn has stopped. Increase maxTurns or split the task into smaller steps and try again.`;
  return {
    event: "max_turns_reached",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.maxTurns.message", params: { maxTurns: args.maxTurns } },
      code: args.error.code,
      userHint: args.error.userHint ?? "Increase maxTurns in local config if this task legitimately needs more agent steps, or split the task into smaller prompts and try again.",
      userHintI18n: { key: "chat:agentStatus.maxTurns.hint" },
      detail: {
        maxTurns: args.maxTurns,
      },
    }),
  };
}

function createMaxOutputRecoveryExhaustedStatus(args: {
  attempts: number;
}): AgentStatusMessage {
  const text = "Output token recovery was exhausted, so the visible response may be incomplete. Increase max output tokens or split the task into smaller steps and try again.";
  return {
    event: "max_output_recovery_exhausted",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.maxOutputRecoveryExhausted.message" },
      severity: "warning",
      code: "max_output_recovery_exhausted",
      userHint: "Increase max output tokens in Settings → Model Provider, or ask the agent to split the answer into smaller parts.",
      userHintI18n: { key: "chat:agentStatus.maxOutputRecoveryExhausted.hint" },
      detail: {
        attempts: args.attempts,
      },
    }),
  };
}

function createStructuredOutputCompletedStatus(): AgentStatusMessage {
  const text = "Structured output was returned, so this turn has completed.";
  return {
    event: "structured_output_completed",
    kind: "status",
    text,
    detail: createAgentTurnStatusDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.structuredOutputCompleted.message" },
      code: "structured_output_completed",
    }),
  };
}

function createContentFilterStopStatus(): AgentStatusMessage {
  const text = "The response may be incomplete because the model stopped due to content filtering.";
  return {
    event: "content_filter_stop",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.contentFilter.message" },
      severity: "warning",
      code: "content_filter_stop",
      userHint: "Retry with a narrower request or adjust the prompt to avoid filtered content; if this seems wrong, check the provider API policy/status for the selected model.",
      userHintI18n: { key: "chat:agentStatus.contentFilter.hint" },
    }),
  };
}

function createUnknownFinishReasonStatus(): AgentStatusMessage {
  const text = "The model stream ended without a normal finish reason, so the response may be incomplete.";
  return {
    event: "unknown_finish_reason",
    kind: "error",
    text,
    detail: createAgentTurnErrorDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.unknownFinishReason.message" },
      severity: "warning",
      code: "unknown_finish_reason",
      userHint: "Retry the turn; if it repeats, check provider API status/logs for stream finish reasons and verify the selected provider/model in Settings → Model Provider.",
      userHintI18n: { key: "chat:agentStatus.unknownFinishReason.hint" },
    }),
  };
}

function createTurnAbortedStatus(args: { reason?: string }): AgentStatusMessage {
  const text = "This turn was aborted before completion.";
  return {
    event: "turn_aborted",
    kind: "status",
    text,
    detail: createAgentTurnStatusDetail({
      message: text,
      messageI18n: { key: "chat:agentStatus.turnAborted.message" },
      code: "turn_aborted",
      userHint: "Retry when you are ready to continue. If this was unexpected, check whether you clicked Stop, switched sessions during a run, or lost the gateway connection.",
      userHintI18n: { key: "chat:agentStatus.turnAborted.hint" },
      detail: {
        reason: args.reason,
      },
    }),
  };
}

function createFinishReasonStatus(finishReason: string | undefined, assistantText: string): AgentStatusMessage | undefined {
  if (assistantText.trim().length === 0) return undefined;
  if (finishReason === "content_filter") return createContentFilterStopStatus();
  if (finishReason === "unknown") return createUnknownFinishReasonStatus();
  return undefined;
}

function createAgentTurnErrorDetail(input: {
  message: string;
  messageI18n?: AgentStatusI18nDescriptor;
  code: string;
  userHint: string;
  userHintI18n?: AgentStatusI18nDescriptor;
  severity?: "error" | "warning";
  detail?: Record<string, unknown>;
}): Record<string, unknown> {
  return createVisibleErrorStatusDetail({
    ...input,
    scope: "turn",
    source: "agent",
  });
}

function createAgentTurnStatusDetail(input: {
  message: string;
  messageI18n?: AgentStatusI18nDescriptor;
  code: string;
  userHint?: string;
  userHintI18n?: AgentStatusI18nDescriptor;
  detail?: Record<string, unknown>;
}): Record<string, unknown> {
  return createAgentStatusDetail({
    ...input,
    visible: true,
    scope: "turn",
    source: "agent",
  });
}

function isTerminalToolError(error: unknown): error is Error & { code?: string; terminal?: true } {
  return Boolean(
    error
    && typeof error === "object"
    && (
      (error as { code?: unknown }).code === "RESULT_UNKNOWN"
      || (error as { terminal?: unknown }).terminal === true
    ),
  );
}

function shouldSurfaceAbortStatus(reason: unknown): boolean {
  if (reason === undefined || reason === null) return false;
  const text = (stringifyAbortReason(reason) ?? "").toLowerCase();
  return text.includes("timeout") || text.includes("cancel") || text.includes("abort");
}

function stringifyAbortReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function isPromptTooLong(error: CanonicalModelError): boolean {
  if (error.code === "prompt_too_long" || error.recoverableViaCompact) {
    return true;
  }
  if (PROMPT_TOO_LONG_ANTHROPIC_PATTERN.test(error.message)) {
    return true;
  }
  if (PROMPT_TOO_LONG_OPENAI_PATTERN.test(error.message)) {
    return true;
  }
  if (REQUEST_TOO_LARGE_PATTERN.test(error.message)) {
    return true;
  }
  return false;
}

function clampOutputToModelCap(requested: number, modelMaxOutputTokens: number | undefined): number | undefined {
  if (!Number.isFinite(requested) || requested <= 0) return undefined;
  const next = Math.floor(requested);
  if (modelMaxOutputTokens !== undefined && Number.isFinite(modelMaxOutputTokens) && modelMaxOutputTokens > 0) {
    return Math.min(next, Math.floor(modelMaxOutputTokens));
  }
  return next;
}

/** Combine the SDK session addendum with the existing turn-local addendum. */
function joinSystemPromptAddenda(...values: Array<string | undefined>): string | undefined {
  const parts = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Validate the JSON-safe model-state projection carried by a sidecar turn. */
export function parseAgentLoopModelSessionStateProjection(value: unknown): AgentLoopModelSessionState | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) throw new Error("Invalid sidecar modelState: expected an object.");
  const tokenCalibration = readArray(value.tokenCalibration, "modelState.tokenCalibration").map((entry) => {
    if (!isPlainRecord(entry)) throw new Error("Invalid sidecar modelState calibration entry.");
    return {
      provider: readNonEmptyString(entry.provider, "modelState calibration provider"),
      model: readNonEmptyString(entry.model, "modelState calibration model"),
      actualInputTokens: readPositiveFiniteNumber(entry.actualInputTokens, "modelState calibration actualInputTokens"),
      estimatedInputTokens: readPositiveFiniteNumber(entry.estimatedInputTokens, "modelState calibration estimatedInputTokens"),
    };
  });
  const tokenCaps = readArray(value.tokenCaps, "modelState.tokenCaps").map((entry) => {
    if (!isPlainRecord(entry)) throw new Error("Invalid sidecar modelState cap entry.");
    const maxContextTokens = readOptionalPositiveFiniteNumber(entry.maxContextTokens, "modelState cap maxContextTokens");
    const sessionMaxOutputTokens = readOptionalPositiveFiniteNumber(entry.sessionMaxOutputTokens, "modelState cap sessionMaxOutputTokens");
    const hardMaxOutputTokens = readOptionalPositiveFiniteNumber(entry.hardMaxOutputTokens, "modelState cap hardMaxOutputTokens");
    if (maxContextTokens === undefined && sessionMaxOutputTokens === undefined && hardMaxOutputTokens === undefined) {
      throw new Error("Invalid sidecar modelState cap entry without a persistent cap.");
    }
    return {
      provider: readNonEmptyString(entry.provider, "modelState cap provider"),
      model: readNonEmptyString(entry.model, "modelState cap model"),
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      ...(sessionMaxOutputTokens !== undefined ? { sessionMaxOutputTokens } : {}),
      ...(hardMaxOutputTokens !== undefined ? { hardMaxOutputTokens } : {}),
    };
  });
  return {
    ...(tokenCalibration.length > 0 ? { tokenCalibration } : {}),
    ...(tokenCaps.length > 0 ? { tokenCaps } : {}),
  };
}

export function serializeAgentLoopModelSessionStateProjection(
  state: AgentLoopModelSessionState,
): Record<string, unknown> {
  return {
    ...(state.tokenCalibration?.length ? { tokenCalibration: state.tokenCalibration.map((entry) => ({ ...entry })) } : {}),
    ...(state.tokenCaps?.length ? { tokenCaps: state.tokenCaps.map((entry) => ({ ...entry })) } : {}),
  };
}

function readArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid sidecar ${field}: expected an array.`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid sidecar ${field}.`);
  return value;
}

function readPositiveFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid sidecar ${field}.`);
  return value;
}

function readOptionalPositiveFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return readPositiveFiniteNumber(value, field);
}

function tokenCalibrationKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function markCompactReplacementMessages(messages: CanonicalMessage[], compactionId: string): CanonicalMessage[] {
  return messages.map((message) => ({
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      compactReplacement: true,
      compactSnapshotId: compactionId,
    },
  }));
}

function compactionSummarySucceeded(result: CompactionResult): boolean {
  return result.error === undefined
    && result.summaryMessage !== undefined;
}

function compactionSummaryGenerated(result: CompactionResult): boolean {
  return result.summaryGenerated
    ?? result.summaryMessage !== undefined;
}

function modelErrorTarget(error: CanonicalModelError, fallbackProvider: string, fallbackModel: string): {
  provider: string;
  model: string;
} {
  return {
    provider: error.provider || fallbackProvider,
    model: error.model || fallbackModel,
  };
}

function composeAbortSignal(args: {
  parent?: AbortSignal;
  timeoutMs?: number;
}): { signal: AbortSignal | undefined; cleanup: () => void; timedOut: () => boolean } {
  const { parent, timeoutMs } = args;
  if (!parent && (!timeoutMs || timeoutMs <= 0)) {
    return { signal: undefined, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  let timedOut = false;
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      const onAbort = () => controller.abort(parent.reason);
      parent.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => parent.removeEventListener("abort", onAbort));
    }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0 && !controller.signal.aborted) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Subagent timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    cleanupFns.push(() => clearTimeout(timeout));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanupFns) fn();
    },
    timedOut: () => timedOut,
  };
}
