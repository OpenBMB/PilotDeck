import { setTimeout as sleep } from "node:timers/promises";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  cloneMessages,
  createModelMessageAssemblerState,
  type CanonicalToolCall,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  type CanonicalMessage,
  type CanonicalModelError,
  ModelProviderError,
  type CanonicalModelRequest,
  type CanonicalToolSchema,
  type CanonicalUsage,
  type CanonicalToolCallBlock,
  materializeMediaReferences,
  type PartialTextToolCallInfo,
  getSelfCorrectPrompt,
  detectFormatByText,
} from "../../model/index.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckReadFileStateMap,
  PilotDeckSubagentForkApi,
  PilotDeckToolErrorResult,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
  PilotDeckWriteSnapshotMap,
} from "../../tool/index.js";
import {
  SUBAGENT_DEFINITIONS,
  getSubagentDefinition,
} from "../sub/builtinSubagentTypes.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { LifecycleDispatchResult } from "../../lifecycle/index.js";
import type { PilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { ContextRecoveryDecision, ContextSupplementalToolResultMessage, TokenBudgetSnapshot } from "../../context/index.js";
import type { PermissionMode, PermissionRule, PermissionRuleSet } from "../../permission/index.js";
import { collectToolCalls } from "./collectToolCalls.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import { LargeFileRepair, type LargeFileRepairDecision } from "./LargeFileRepair.js";
import { resolveOutputTokenRetryBump } from "./outputTokenRetry.js";
import { projectToolResults } from "./projectToolResults.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";
import type { AgentRunMode } from "../protocol/input.js";
import {
  ASK_MODE_DESCRIPTION_SUFFIX,
  isAskModeAllowedTool,
} from "../../tool/askModeConstraints.js";
import { buildAskModeAgentToolSchema } from "../../tool/builtin/agent.js";
import { repairToolName } from "../../model/streaming/repairToolName.js";
import {
  createAgentStatusDetail,
  createVisibleErrorStatusDetail,
  type AgentStatusI18nDescriptor,
} from "../../status/agentStatus.js";

const TOOL_EVENT_PUMP_INTERVAL_MS = 500;
const SUBAGENT_STATUS_HEARTBEAT_MS = 2_000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096;
const EMPTY_LENGTH_OUTPUT_RETRY_FLOOR = 4_096;
const CIRCUIT_BREAKER_GRACE_PROMPT = [
  "Your last several tool calls all failed input validation with the same error.",
  "This may indicate a tool-side issue rather than a problem with your approach.",
  "Options: (1) try a different tool or different parameters,",
  "(2) explain the situation in text without calling tools,",
  "(3) if you believe the tool should work, try once more with corrected input.",
].join(" ");
const PLAN_MODE_REMINDER_MESSAGE = [
  "Plan mode is active.",
  "Read first using read-only tools, then write or refine plan markdown only under `.pilotdeck/plans/`.",
  "Do not make implementation changes while planning.",
  "When the plan is ready for user review, call `exit_plan_mode` with the plan file path.",
].join("\n");

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
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  abortSignal?: AbortSignal;
  onDurableMessage?: (message: CanonicalMessage) => void | Promise<void>;
  onAgentStatusMessage?: (status: AgentStatusMessage) => void | Promise<void>;
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

export class AgentLoop {
  private readonly readFileState: PilotDeckReadFileStateMap;
  private readonly writeSnapshots: PilotDeckWriteSnapshotMap;
  private readonly allowedReadFiles: Set<string>;
  private readonly transientTokenCaps = new Map<string, {
    maxContextTokens?: number;
    requestedMaxOutputTokens?: number;
    attemptMaxOutputTokens?: number;
    hardMaxOutputTokens?: number;
  }>();

  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly dependencies: AgentRuntimeDependencies,
    seedState?: AgentLoopSeedState,
  ) {
    this.readFileState = cloneReadFileStateMap(seedState?.readFileState);
    this.writeSnapshots = cloneWriteSnapshotMap(seedState?.writeSnapshots);
    this.allowedReadFiles = new Set(seedState?.allowedReadFiles ?? []);
  }

  snapshotFileState(): AgentLoopSeedState {
    return {
      readFileState: cloneReadFileStateMap(this.readFileState),
      writeSnapshots: cloneWriteSnapshotMap(this.writeSnapshots),
      allowedReadFiles: [...this.allowedReadFiles],
    };
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.clearTurnScopedTokenCaps();
    this.applyRunModeOverride(input.runMode);
    this.applyPermissionOverrides(input.permissionMode, input.permissionRules, input.basePermissionMode);
    for (const filePath of input.allowedReadFiles ?? []) {
      this.allowedReadFiles.add(filePath);
    }
    const startedAt = this.now().toISOString();
    let messages = [...input.messages];
    let turnCount = 1;
    let usage: CanonicalUsage = {};
    let lastModelUsage: CanonicalUsage | undefined;
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
    const captureTurn = async (errored: boolean): Promise<void> => {
      const hook = this.dependencies.context?.captureTurn;
      if (!hook) return;
      try {
        await hook.call(this.dependencies.context, {
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
    let hasAttemptedToolCallRetry = false;
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
      const transientId = this.dependencies.uuid?.() ?? `transient-${++transientPromptCounter}`;
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

    const stickyInfo = this.dependencies.router.invalidateSticky?.(input.sessionId);
    let previousTier: string | undefined = stickyInfo?.previousTier;

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
      if (this.config.maxOutputTokens !== undefined
        && this.config.maxOutputTokens < largeFileRepair.recommendedMaxOutputTokens) {
        this.config.maxOutputTokens = largeFileRepair.recommendedMaxOutputTokens;
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

      let pendingContextBudget: TokenBudgetSnapshot | undefined;
      const ctx = this.dependencies.context;
      const preRoutingMaxContextTokens = this.currentMaxContextTokens(this.config.provider, this.config.model);
      if (ctx?.tryAutoCompact) {
        try {
          const reservedOutputTokens = this.getReservedOutputTokens();
          const compact = await ctx.tryAutoCompact({
            messages,
            abortSignal: input.abortSignal,
            reservedOutputTokens,
            lastUsage: lastModelUsage,
            budgetEvaluator: this.createBudgetEvaluator(input, {
              maxContextTokens: preRoutingMaxContextTokens,
              reservedOutputTokens,
            }),
          });
          if (compact.type === "compacted") {
            messages = compact.messages;
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "auto_compact",
            };
          }
          pendingContextBudget = compact.snapshot;
        } catch {
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

      // Split decide + execute so we can insert a post-routing compact pass
      // when the routed model's context window differs from the agent's
      // default model (the window used by the first tryAutoCompact above).
      const decision = await this.dependencies.router.decide({
        request,
        sessionId: input.sessionId,
        isMainAgent: !this.config.isSubagent,
        metadata: stickyInfo
          ? {
            previousTier,
            previousProvider: stickyInfo.previousProvider,
            previousModel: stickyInfo.previousModel,
          }
          : previousTier ? { previousTier } : undefined,
      });
      const routedLimits = this.getModelTokenLimits(decision.provider, decision.model);
      const routedMaxOutputTokens = routedLimits?.maxOutputTokens;

      let emittedContextBudget = false;
      if (ctx?.tryAutoCompact) {
        const routedMaxCtx = routedLimits?.maxContextTokens ?? this.dependencies.getModelMaxContextTokens?.(decision.provider, decision.model);
        const currentBudgetMaxCtx = preRoutingMaxContextTokens;
        if (routedMaxCtx !== undefined && routedMaxCtx !== currentBudgetMaxCtx) {
          try {
            const reservedOutputTokens = this.getReservedOutputTokens(decision.provider, decision.model);
            const recompact = await ctx.tryAutoCompact({
              messages,
              abortSignal: input.abortSignal,
              maxContextTokens: routedMaxCtx,
              reservedOutputTokens,
              lastUsage: lastModelUsage,
              budgetEvaluator: this.createBudgetEvaluator(input, {
                decision,
                baseRequest: request,
                maxContextTokens: routedMaxCtx,
                reservedOutputTokens,
              }),
            });
            if (recompact.type === "compacted") {
              messages = recompact.messages;
              request = await this.createModelRequest(messages, input);
              request = this.applyTokenCapsToRequest(request, decision.provider, decision.model);
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "auto_compact",
              };
            }
            yield {
              type: "context_budget",
              sessionId: input.sessionId,
              turnId: input.turnId,
              snapshot: recompact.snapshot,
            };
            emittedContextBudget = true;
          } catch {
            // Post-routing compaction must never block the model call.
          }
        }
      }
      request = this.applyTokenCapsToRequest(request, decision.provider, decision.model);
      this.clearAttemptOutputTokenCap(decision.provider, decision.model);
      if (pendingContextBudget && !emittedContextBudget) {
        yield {
          type: "context_budget",
          sessionId: input.sessionId,
          turnId: input.turnId,
          snapshot: pendingContextBudget,
        };
      }

      const assembler = createModelMessageAssemblerState();
      try {
        for await (const event of this.dependencies.router.execute(decision, request, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          projectPath: this.config.cwd,
          abortSignal: input.abortSignal,
        })) {
          yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event };
          applyModelEventToAssembler(assembler, event);
          if (event.type === "error") {
            break;
          }
        }
        if (!stickyInfo?.orchestrating) previousTier = undefined;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          const partialAssembled = assembleAssistantMessage(assembler);
          if (partialAssembled.message.content.length > 0) {
            finalMessage = partialAssembled.message;
            messages.push(partialAssembled.message);
            expireConsumedTransientPrompts();
            usage = mergeUsage(usage, partialAssembled.usage);
            yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: partialAssembled.message };
            await input.onDurableMessage?.(partialAssembled.message);
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
        if (partialAssembled.message.content.length > 0) {
          finalMessage = partialAssembled.message;
          messages.push(partialAssembled.message);
          expireConsumedTransientPrompts();
          usage = mergeUsage(usage, partialAssembled.usage);
          yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: partialAssembled.message };
          await input.onDurableMessage?.(partialAssembled.message);
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
      usage = mergeUsage(usage, assembled.usage);
      lastModelUsage = assembled.usage;
      let assistantMessage = assembled.message;
      let toolCalls = collectToolCalls(assistantMessage);
      if (assembled.hasTextFallbackToolCalls) {
        const repaired = this.repairTextExtractedToolNames(assistantMessage, toolCalls);
        assistantMessage = repaired.message;
        toolCalls = repaired.toolCalls;
      }
      finalMessage = assistantMessage;
      expireConsumedTransientPrompts();

      if (assembled.hasPartialTextToolCall) {
        if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          maxOutputRecoveryCount++;
          pushTransientSyntheticPrompt(
            buildPartialTextToolCallRecoveryPrompt(assembled.partialTextToolCall),
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

        const detail = assembled.partialTextToolCall
          ? `${assembled.partialTextToolCall.format}/${assembled.partialTextToolCall.reason}`
          : "unknown partial text tool-call";
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
            `Partial text tool-call recovery exhausted after ${MAX_OUTPUT_RECOVERY_LIMIT} attempts (${detail}).`,
          )],
        });
        yield await emitStatus(createToolCallRecoveryExhaustedStatus({
          error: result.errors![0]!,
          attempts: maxOutputRecoveryCount,
          reason: detail,
        }));
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

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
              const compact = await ctx.tryAutoCompact({
                messages,
                abortSignal: input.abortSignal,
                maxContextTokens: this.currentMaxContextTokens(target.provider, target.model),
                reservedOutputTokens: this.getReservedOutputTokens(target.provider, target.model),
                lastUsage: lastModelUsage,
              });
              if (compact.type === "compacted") {
                messages = compact.messages;
              } else {
                messages = truncateHeadKeepRatio(messages, 0.5);
              }
            } catch {
              messages = truncateHeadKeepRatio(messages, 0.5);
            }
          } else {
            messages = truncateHeadKeepRatio(messages, 0.5);
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
          hasAttemptedCompact = true;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        if (reactive && reactive.type === "strip_images_and_retry") {
          messages = stripTrailingErrorPair(messages);
          messages = stripImagesFromMessages(messages);
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

        if (!assembled.hasPartialTextToolCall && assembled.hasUnparsedTextToolCall) {
          if (!hasAttemptedToolCallRetry) {
            hasAttemptedToolCallRetry = true;
            pushTransientSyntheticPrompt(
              getSelfCorrectPrompt(this.config.toolCallFormat ?? assembled.textToolCallFormat, assistantText),
              "unparsed_tool_call_retry",
            );
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }

          yield {
            type: "warning",
            sessionId: input.sessionId,
            turnId: input.turnId,
            code: "unparsed_tool_call",
            message: "Model attempted to call a tool but the output could not be parsed. The response may be incomplete.",
            metadata: {
              detectedFormat: assembled.textToolCallFormat ?? detectFormatByText(assistantText)?.id,
            },
          };
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
        const toolContext = this.createToolContext(input, messages);
        if (assembled.finishReason === "length" || assembled.hasRepairedToolCalls) {
          toolContext.outputTruncated = true;
        }
        results = yield* this.executeToolsWithEventPump(
          toolCalls,
          toolContext,
          input,
        );
      } catch (error) {
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
      const ctxApply = this.dependencies.context?.applyToolResults;
      if (ctxApply) {
        try {
          const applied = await ctxApply.call(this.dependencies.context, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolResultMessage: toolResultMsg,
            supplementalMessages: supplementalInputs,
            messages,
          });
          messages = applied.messages;
          appendedMessages = applied.appendedMessages ?? projected;
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
        hasAttemptedToolCallRetry = false;
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
    const ctx: AgentContextRuntime | undefined = this.dependencies.context;
    if (!ctx?.recoverFromModelError) {
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
    options: { emitInstructionEvents?: boolean } = {},
  ): Promise<CanonicalModelRequest> {
    const contextRuntime = this.dependencies.context ?? new NullContextRuntime();
    const planTodo = this.dependencies.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const promptBlockedToolNames = canPrompt
      ? new Set<string>()
      : new Set(
          this.dependencies.tools.registry.list()
            .filter((tool) => requiresPromptCapability(tool, {}))
            .map((tool) => tool.name),
        );
    let toolDefinitions = this.dependencies.tools.registry.list()
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
    const prepared = await contextRuntime.prepareForModel({
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      runMode: this.config.runMode ?? "agent",
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages: cloneMessages(requestMessages),
      tools,
      maxMessages: this.config.maxContextMessages,
      customSystemPrompt: this.config.systemPrompt,
      appendSystemPrompt: planTodo?.buildPromptAddendum(),
      abortSignal: input.abortSignal,
    });

    if (options.emitInstructionEvents !== false) {
      this.dispatchLifecycle(input, "InstructionsLoaded", {
        hasSystemPrompt: !!prepared.systemPrompt,
      }).catch(() => {});
      this.dependencies.eventEmitter?.({
        type: "instructions_loaded",
        sessionId: input.sessionId,
        turnId: input.turnId,
        hasSystemPrompt: !!prepared.systemPrompt,
      });
    }

    const materialized = await materializeMediaReferences(prepared.messages);
    for (const diagnostic of materialized.diagnostics) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pilotdeck] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.mediaType}, ${diagnostic.path})`,
      );
    }

    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: this.config.permissionMode === "plan"
        ? appendPlanModeReminder(materialized.messages)
        : materialized.messages,
      systemPrompt: prepared.systemPrompt ?? this.config.systemPrompt,
      tools: prepared.tools,
      toolChoice: this.config.toolChoice,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      thinking: this.config.thinking,
      stream: true,
      metadata: this.config.metadata,
      cacheBreakpoints: prepared.cacheBreakpoints,
    };
  }

  private createBudgetEvaluator(
    input: AgentLoopInput,
    options: {
      decision?: import("../../router/index.js").RouterDecision;
      baseRequest?: CanonicalModelRequest;
      maxContextTokens?: number;
      reservedOutputTokens: number;
    },
  ): ((candidateMessages: CanonicalMessage[], lastUsage?: CanonicalUsage) => Promise<TokenBudgetSnapshot>) | undefined {
    const tokenAccounting = this.dependencies.tokenAccounting;
    const maxContextTokens = options.maxContextTokens;
    if (!tokenAccounting || !maxContextTokens) {
      return undefined;
    }
    return async (candidateMessages, lastUsage) => {
      let candidateRequest = await this.createModelRequest(candidateMessages, input, {
        emitInstructionEvents: false,
      });
      if (options.decision && options.baseRequest && this.dependencies.router.materializeRequest) {
        const patchedBase = { ...options.baseRequest, messages: candidateRequest.messages };
        candidateRequest = this.dependencies.router.materializeRequest(options.decision, {
          ...patchedBase,
          systemPrompt: candidateRequest.systemPrompt,
          tools: candidateRequest.tools,
          cacheBreakpoints: candidateRequest.cacheBreakpoints,
        });
      }
      const snapshot = await tokenAccounting.evaluateRequestBudget(candidateRequest, {
        maxContextTokens,
        reservedOutputTokens: options.reservedOutputTokens,
        signal: input.abortSignal,
      });
      const usageTokens = tokensFromUsage(lastUsage);
      if (usageTokens === undefined || usageTokens <= snapshot.tokens) {
        return snapshot;
      }
      return tokenAccounting.snapshotFromTokens(usageTokens, maxContextTokens, {
        reservedOutputTokens: options.reservedOutputTokens,
        usageTokens,
        source: snapshot.source,
        exact: snapshot.exact,
        estimatorError: snapshot.estimatorError,
      });
    };
  }

  private getReservedOutputTokens(provider?: string, model?: string): number {
    if (provider && model) {
      return this.currentMaxOutputTokens(provider, model) ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    }
    return this.currentMaxOutputTokens(this.config.provider, this.config.model) ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  }

  private tokenCapKey(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  private getModelTokenLimits(provider: string, model: string): { maxContextTokens?: number; maxOutputTokens?: number } | undefined {
    const combined = this.dependencies.getModelTokenLimits?.(provider, model);
    if (combined) return combined;
    const maxContextTokens = this.dependencies.getModelMaxContextTokens?.(provider, model);
    const maxOutputTokens = this.dependencies.getModelMaxOutputTokens?.(provider, model);
    if (maxContextTokens === undefined && maxOutputTokens === undefined) return undefined;
    return { maxContextTokens, maxOutputTokens };
  }

  private currentMaxContextTokens(provider: string, model: string): number {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model))?.maxContextTokens;
    return transient ?? this.getModelTokenLimits(provider, model)?.maxContextTokens ?? this.config.maxContextTokens ?? 1_000_000;
  }

  private currentMaxOutputTokens(provider: string, model: string): number | undefined {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model));
    const modelMaxOutputTokens = this.getModelTokenLimits(provider, model)?.maxOutputTokens;
    const requested = transient?.attemptMaxOutputTokens ?? transient?.requestedMaxOutputTokens ?? this.config.maxOutputTokens ?? modelMaxOutputTokens;
    const candidates = [requested, modelMaxOutputTokens, transient?.hardMaxOutputTokens]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    return candidates.length > 0 ? Math.min(...candidates.map((value) => Math.floor(value))) : undefined;
  }

  private setTransientTokenCap(provider: string, model: string, cap: {
    maxContextTokens?: number;
    requestedMaxOutputTokens?: number;
    attemptMaxOutputTokens?: number;
    hardMaxOutputTokens?: number;
  }): void {
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
      if (sessionCaps.maxContextTokens === undefined && sessionCaps.hardMaxOutputTokens === undefined) {
        this.transientTokenCaps.delete(key);
      } else {
        this.transientTokenCaps.set(key, sessionCaps);
      }
    }
  }

  private applyTokenCapsToRequest(request: CanonicalModelRequest, provider: string, model: string): CanonicalModelRequest {
    return {
      ...request,
      provider,
      model,
      maxOutputTokens: this.currentMaxOutputTokens(provider, model),
    };
  }

  private repairTextExtractedToolNames(
    message: CanonicalMessage,
    toolCalls: CanonicalToolCall[],
  ): { message: CanonicalMessage; toolCalls: CanonicalToolCall[] } {
    if (toolCalls.length === 0) return { message, toolCalls };
    const validNames = new Set(this.dependencies.tools.registry.list().map((tool) => tool.name));
    const repairedById = new Map<string, string>();
    const repairedToolCalls = toolCalls.map((call) => {
      const repaired = repairToolName(call.name, validNames, this.config.toolAliases);
      if (!repaired) return call;
      repairedById.set(call.id, repaired.name);
      return { ...call, name: repaired.name };
    });
    if (repairedById.size === 0) return { message, toolCalls };

    return {
      message: {
        ...message,
        content: message.content.map((block) => {
          if (block.type !== "tool_call") return block;
          const repairedName = repairedById.get(block.id);
          return repairedName ? ({ ...block, name: repairedName } satisfies CanonicalToolCallBlock) : block;
        }),
      },
      toolCalls: repairedToolCalls,
    };
  }

  private createToolContext(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): PilotDeckToolRuntimeContext {
    const planDirectoryPath = this.dependencies.planFileManager?.getPlanDirectoryPath();
    const planTodo = this.dependencies.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const permissionContext = {
      ...this.config.permissionContext,
      cwd: this.config.cwd,
      canPrompt,
      ...(planDirectoryPath ? { planDirectoryPath } : {}),
    };
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
      auditRecorder: this.dependencies.auditRecorder,
      now: this.now,
      env: this.config.env,
      maxResultBytes: this.config.maxResultBytes,
      // Tools that need a secondary model call (e.g. `agent` subagents in
      // fallback mode, `web_fetch` extraction) get a thin adapter that
      // funnels into the router's stream so subagents inherit fallback /
      // zero-usage retry.
      model: {
        stream: (request, signal) =>
          this.dependencies.router.stream(request, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            projectPath: this.config.cwd,
            abortSignal: signal,
            isMainAgent: false,
          }),
      },
      elicitation: this.dependencies.elicitation,
      fileHistory: this.dependencies.fileHistory,
      subagentDepth: this.config.subagentDepth ?? 0,
      subagent: this.buildSubagentForkApi(input, messages),
      modelMultimodal: this.config.modelMultimodal,
      maxOutputTokens: this.config.maxOutputTokens,
      readFileState: this.readFileState,
      allowedReadFiles: [...this.allowedReadFiles],
      writeSnapshots: this.writeSnapshots,
      fileUpdateNotifier: this.dependencies.fileUpdateNotifier,
      ...(planTodo ? { planTodo } : {}),
      ...(planDirectoryPath
        ? {
            planDirectory: {
              path: planDirectoryPath,
              resolve: (filePath: string) =>
                this.dependencies.planFileManager?.resolvePlanFilePath(filePath, this.config.cwd),
              read: (filePath: string) =>
                this.dependencies.planFileManager?.readPlanFile(filePath, this.config.cwd),
            },
          }
        : {}),
    };
  }

  private buildSubagentForkApi(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): PilotDeckSubagentForkApi {
    const depth = this.config.subagentDepth ?? 0;
    const maxDepth = this.config.maxSubagentDepth ?? 1;
    return {
      depth,
      maxSubagentDepth: maxDepth,
      listDefinitions: () =>
        Object.values(SUBAGENT_DEFINITIONS).map((d) => ({
          id: d.id,
          description: d.description,
        })),
      isAllowedDefinition: (id: string) => getSubagentDefinition(id) !== undefined,
      fork: async ({ definitionId, directive, subagentId, toolCallId, abortSignal, timeoutMs }) => {
        // Defer SubAgentSession import to avoid the runtime cycle (sub → loop → sub).
        const { SubAgentSession } = await import("../sub/SubAgentSession.js");
        const def = getSubagentDefinition(definitionId);
        if (!def) throw new Error(`Unknown subagent type: ${definitionId}`);
        const composedAbort = composeAbortSignal({
          parent: abortSignal,
          timeoutMs,
        });

        const subagentSessionId = `${this.config.cwd}::sub::${subagentId}`;
        const transcriptHooks = this.dependencies.subagentTranscript;
        const sidechain = transcriptHooks?.subagentTranscriptResolver?.(subagentId);
        const transcriptRelativePath = sidechain?.transcriptRelativePath ?? "";

        await transcriptHooks?.recordSubagentStarted?.({
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          prompt: directive,
          transcriptRelativePath,
          subagentSessionId,
        });
        await this.dispatchLifecycle(input, "SubagentStart", {
          subagentId,
          subagentType: def.id,
        });
        this.dependencies.eventEmitter?.({
          type: "subagent_started",
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          toolCallId,
        });

        const subSession = new SubAgentSession({
          definition: def,
          directive,
          parentConfig: {
            ...this.config,
            subagentDepth: depth + 1,
            isSubagent: true,
          },
          parentDependencies: this.dependencies,
          parentReadFileState: this.readFileState,
          parentWriteSnapshots: this.writeSnapshots,
          parentSessionId: input.sessionId,
          parentTurnId: input.turnId,
          subagentSessionId,
          subagentId,
          abortSignal: composedAbort.signal,
          sidechainTranscript: sidechain
            ? {
                recordAcceptedInput: sidechain.recordAcceptedInput.bind(sidechain),
                recordDurableMessage: sidechain.recordDurableMessage.bind(sidechain),
              }
            : undefined,
        });

        let report;
        let errored = false;
        try {
          report = await subSession.run();
          if (composedAbort.timedOut()) {
            throw new Error(`Subagent timed out after ${timeoutMs}ms.`);
          }
        } catch (err) {
          composedAbort.cleanup();
          errored = true;
          await transcriptHooks?.recordSubagentCompleted?.({
            sessionId: input.sessionId,
            turnId: input.turnId,
            subagentId,
            subagentType: def.id,
            summary: err instanceof Error ? err.message : String(err),
            turns: 0,
            durationMs: 0,
            errored: true,
          });
          await this.dispatchLifecycle(input, "SubagentStop", {
            subagentId,
            subagentType: def.id,
            success: false,
          });
          this.dependencies.eventEmitter?.({
            type: "subagent_completed",
            sessionId: input.sessionId,
            turnId: input.turnId,
            subagentId,
            subagentType: def.id,
            success: false,
            durationMs: 0,
          });
          throw err;
        }
        composedAbort.cleanup();

        await transcriptHooks?.recordSubagentCompleted?.({
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          summary: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          errored,
        });
        await this.dispatchLifecycle(input, "SubagentStop", {
          subagentId,
          subagentType: def.id,
          success: !errored,
        });
        this.dependencies.eventEmitter?.({
          type: "subagent_completed",
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          success: !errored,
          durationMs: report.durationMs,
        });

        return {
          markdown: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          parsed: report.parsed as unknown as Record<string, string> | undefined,
        };
      },
    };
  }

  private async dispatchLifecycle(
    input: AgentLoopInput,
    event: PilotDeckHookEvent,
    payload: Record<string, unknown>,
  ): Promise<LifecycleDispatchResult> {
    return this.dependencies.lifecycle?.dispatch({
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
      env: this.config.env,
    }) ?? {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }

  private *drainEventBuffer(): Generator<AgentEvent> {
    const events = this.dependencies.drainEvents?.() ?? [];
    for (const event of events) {
      yield event;
    }
  }

  private async *executeToolsWithEventPump(
    toolCalls: CanonicalToolCall[],
    context: PilotDeckToolRuntimeContext,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, PilotDeckToolResult[], unknown> {
    const activeSubagents = new Map<string, ActiveSubagentStatus>();
    let results: PilotDeckToolResult[] | undefined;
    let error: unknown;
    let settled = false;

    const execution = this.dependencies.tools.scheduler.executeAll(toolCalls, context)
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
    return results ?? [];
  }

  private *drainToolEventBufferForSubagentStatus(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const events = this.dependencies.drainEvents?.() ?? [];
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
    };
  }

  private applyPermissionOverrides(
    permissionMode?: PermissionMode,
    permissionRules?: Partial<PermissionRuleSet>,
    basePermissionMode?: PermissionMode,
  ): void {
    if (permissionMode) {
      if (permissionMode === "plan" && this.config.permissionMode !== "plan") {
        this.config.permissionModeBeforePlan = basePermissionMode ?? this.config.permissionMode;
      }
      this.config.permissionMode = permissionMode;
      this.config.permissionContext.mode = permissionMode;
    }
    if (!permissionRules) return;
    mergeUserRules(this.config.permissionContext.rules.allow, permissionRules.allow);
    mergeUserRules(this.config.permissionContext.rules.deny, permissionRules.deny);
    mergeUserRules(this.config.permissionContext.rules.ask, permissionRules.ask);
  }

  private applyRunModeOverride(runMode?: AgentRunMode): void {
    if (runMode) {
      this.config.runMode = runMode;
    } else {
      this.config.runMode ??= "agent";
    }
  }

  private readonly now = (): Date => this.dependencies.now?.() ?? new Date();
}

function mergeUserRules(target: PermissionRule[], userRules: PermissionRule[] | undefined): void {
  const nonUserRules = target.filter((rule) => rule.source !== "user");
  target.splice(0, target.length, ...nonUserRules, ...(userRules ?? []));
}

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

function appendPlanModeReminder(messages: CanonicalMessage[]): CanonicalMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: PLAN_MODE_REMINDER_MESSAGE }],
      metadata: { synthetic: true, purpose: "plan_mode_reminder" },
    },
  ];
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

function buildPartialTextToolCallRecoveryPrompt(
  partial: PartialTextToolCallInfo | undefined,
): string {
  const evidence = partial
    ? `Detected partial text tool-call syntax (${partial.format}/${partial.reason}). Preview: ${partial.preview}`
    : "Detected partial text tool-call syntax.";
  return [
    "The previous response contained partial tool-call XML/text and could not be safely executed.",
    evidence,
    "Resend the complete intended tool call with all required parameters, or continue in visible text if no tool is needed.",
    "Do not repeat dangling XML/tool-call fragments.",
  ].join("\n");
}

/** Keep only the trailing `keepRatio` portion of the message history. */
function truncateHeadKeepRatio(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  const ratio = Math.max(0.05, Math.min(1, keepRatio));
  const keep = Math.max(1, Math.floor(messages.length * ratio));
  return messages.slice(-keep);
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

function normalizeMessagesForModelRequest(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (
      last?.role === "assistant" &&
      message.role === "assistant" &&
      canMergeAssistantMessages(last, message)
    ) {
      out[out.length - 1] = {
        role: "assistant",
        content: [...last.content, ...message.content],
        metadata: mergeMessageMetadata(last.metadata, message.metadata),
      };
      continue;
    }
    out.push(message);
  }
  return out;
}

function canMergeAssistantMessages(first: CanonicalMessage, second: CanonicalMessage): boolean {
  return !hasToolCallBlock(first) && !hasToolCallBlock(second);
}

function hasToolCallBlock(message: CanonicalMessage): boolean {
  return message.content.some((block) => block.type === "tool_call");
}

function mergeMessageMetadata(
  first: CanonicalMessage["metadata"],
  second: CanonicalMessage["metadata"],
): CanonicalMessage["metadata"] {
  if (!first && !second) {
    return undefined;
  }
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
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
  if (error.code === "prompt_too_long" || error.code === "context_overflow") {
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

function tokensFromUsage(usage: CanonicalUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) {
    return undefined;
  }
  const outputTokens = typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens > 0
    ? usage.outputTokens
    : 0;
  return Math.ceil(inputTokens + outputTokens);
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
