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
  type CanonicalModelRequest,
  type CanonicalUsage,
  materializeMediaReferences,
} from "../../model/index.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckSubagentForkApi,
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
import type { ContextRecoveryDecision, ContextSupplementalToolResultMessage } from "../../context/index.js";
import {
  normalizeSudoPermissionPolicy,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSet,
  type SudoPermissionPolicy,
} from "../../permission/index.js";
import { collectToolCalls } from "./collectToolCalls.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import { LargeFileRepair, type LargeFileRepairDecision } from "./LargeFileRepair.js";
import { projectToolResults } from "./projectToolResults.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";

const TOOL_EVENT_PUMP_INTERVAL_MS = 500;
const SUBAGENT_STATUS_HEARTBEAT_MS = 2_000;
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

export type AgentLoopInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  maxTurns?: number;
  permissionMode?: PermissionMode;
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  sudoPolicy?: Partial<SudoPermissionPolicy>;
  abortSignal?: AbortSignal;
  onDurableMessage?: (message: CanonicalMessage) => void | Promise<void>;
};

export type AgentLoopRunResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type AgentLoopSeedState = {
  readFileState?: PilotDeckReadFileStateMap;
  writeSnapshots?: PilotDeckWriteSnapshotMap;
};

export class AgentLoop {
  private readonly readFileState: PilotDeckReadFileStateMap;
  private readonly writeSnapshots: PilotDeckWriteSnapshotMap;

  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly dependencies: AgentRuntimeDependencies,
    seedState?: AgentLoopSeedState,
  ) {
    this.readFileState = cloneReadFileStateMap(seedState?.readFileState);
    this.writeSnapshots = cloneWriteSnapshotMap(seedState?.writeSnapshots);
  }

  snapshotFileState(): AgentLoopSeedState {
    return {
      readFileState: cloneReadFileStateMap(this.readFileState),
      writeSnapshots: cloneWriteSnapshotMap(this.writeSnapshots),
    };
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.applyPermissionOverrides(input.permissionMode, input.permissionRules, input.basePermissionMode, input.sudoPolicy);
    const startedAt = this.now().toISOString();
    let messages = [...input.messages];
    let turnCount = 1;
    let usage: CanonicalUsage = {};
    let permissionDenials: AgentPermissionDenial[] = [];
    let structuredOutput: unknown;
    let finalMessage: CanonicalMessage | undefined;
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
     * Single-shot guard for `max_output_reached` retries. The loop bumps
     * `config.maxOutputTokens` (capped at `OUTPUT_TOKEN_RETRY_CEILING`) once
     * and retries; a second hit falls through to the continuation recovery.
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
    const largeFileRepair = new LargeFileRepair();

    /**
     * Circuit breaker: consecutive turns where ALL tool calls are
     * `invalid_tool_input` errors. When the model is stuck in a loop
     * (e.g. qwen repeatedly emitting empty-param bash calls), terminate
     * early instead of burning tokens. Resets on any turn with at least
     * one successful tool call.
     */
    const MAX_CONSECUTIVE_ALL_INVALID_TURNS = 3;
    let consecutiveAllInvalidTurns = 0;

    const stickyInfo = this.dependencies.router.invalidateSticky?.(input.sessionId);
    let previousTier: string | undefined = stickyInfo?.previousTier;

    const continueWithSyntheticPrompt = async (decision: LargeFileRepairDecision): Promise<{
      type: "continue";
      event: AgentEvent;
    } | {
      type: "completed";
      result: AgentTurnResult;
    }> => {
      if (decision.type === "stop") {
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError("agent_tool_error_loop", decision.reason)],
        });
        return { type: "completed", result };
      }
      if (decision.strip === "error_pair") {
        messages = stripTrailingErrorPair(messages);
      } else if (decision.strip === "assistant") {
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          messages = messages.slice(0, -1);
        }
      }
      messages.push({
        role: "user",
        content: [{ type: "text", text: decision.prompt }],
        metadata: { synthetic: true, purpose: decision.purpose },
      });
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
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const ctx = this.dependencies.context;
      if (ctx?.tryAutoCompact) {
        try {
          const compact = await ctx.tryAutoCompact({
            messages,
            abortSignal: input.abortSignal,
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
          yield {
            type: "context_budget",
            sessionId: input.sessionId,
            turnId: input.turnId,
            snapshot: compact.snapshot,
          };
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
      // when the routed model's context window is smaller than the agent's
      // default model (the window used by the first tryAutoCompact above).
      const decision = await this.dependencies.router.decide({
        request,
        sessionId: input.sessionId,
        isMainAgent: !this.config.isSubagent,
        metadata: previousTier ? { previousTier } : undefined,
      });

      const getMaxCtx = this.dependencies.getModelMaxContextTokens;
      const agentMaxCtx = this.config.maxContextTokens;
      if (ctx?.tryAutoCompact && getMaxCtx && agentMaxCtx) {
        const routedMaxCtx = getMaxCtx(decision.provider, decision.model);
        if (routedMaxCtx !== undefined && routedMaxCtx < agentMaxCtx) {
          try {
            const recompact = await ctx.tryAutoCompact({
              messages,
              abortSignal: input.abortSignal,
              maxContextTokens: routedMaxCtx,
            });
            if (recompact.type === "compacted") {
              messages = recompact.messages;
              request = await this.createModelRequest(messages, input);
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
          } catch {
            // Post-routing compaction must never block the model call.
          }
        }
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
        const stopFailureMsg = error instanceof Error ? error.message : String(error);
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
          errors: [agentError("agent_model_error", stopFailureMsg)],
        });
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

      const assembled = assembleAssistantMessage(assembler);
      usage = mergeUsage(usage, assembled.usage);
      finalMessage = assembled.message;
      messages.push(assembled.message);
      yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: assembled.message };
      await input.onDurableMessage?.(assembled.message);

      const toolCalls = collectToolCalls(assembled.message);
      if (assembled.error) {
        if (toolCalls.length > 0) {
          const projected = projectToolResults(
            toolCalls.map((call) => createMissingToolResult(call, this.now, "Model error interrupted tool execution.")),
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
          messages.push({
            role: "user",
            content: [{
              type: "text",
              text: "Your previous tool call contained invalid JSON in the arguments and could not be parsed. "
                + "Please retry with valid JSON. Common issues: missing quotes around keys/values, "
                + "trailing commas, unescaped special characters in strings.",
            }],
            metadata: { synthetic: true, purpose: "json_self_correct" },
          });
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
        // Phase A — single-shot token doubling: strip the partial response
        // and retry with 2x maxOutputTokens (capped at CEILING).
        // Phase B — multi-turn continuation: keep the truncated assistant
        // message in context and inject a "resume" prompt so the model can
        // pick up where it was cut off (up to MAX_OUTPUT_RECOVERY_LIMIT).
        // Phase C — exhausted: fall through to error surfacing.
        if (assembled.error.code === "max_output_reached") {
          // Phase A
          if (!hasAttemptedOutputRetry) {
            messages = stripTrailingErrorPair(messages);
            const previous = this.config.maxOutputTokens ?? OUTPUT_TOKEN_RETRY_DEFAULT;
            this.config.maxOutputTokens = Math.min(previous * 2, OUTPUT_TOKEN_RETRY_CEILING);
            hasAttemptedOutputRetry = true;
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          }

          // Phase B
          if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
            maxOutputRecoveryCount++;
            messages.push({
              role: "user",
              content: [{
                type: "text",
                text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing. "
                  + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
              }],
              metadata: { synthetic: true, purpose: "max_output_recovery" },
            });
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
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (toolCalls.length === 0) {
        const assistantText = textFromMessage(assembled.message);

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
              messages.push({
                role: "user",
                content: [{
                  type: "text",
                  text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing. "
                    + "Pick up mid-sentence if that is where the cut happened.",
                }],
                metadata: { synthetic: true, purpose: "max_output_recovery" },
              });
              yield {
                type: "turn_continued",
                sessionId: input.sessionId,
                turnId: input.turnId,
                reason: "model_error",
              };
              continue;
            }
            // Exhausted consecutive empty retries — surface error via frontend banner.
            finalMessage = messages.filter((m) => m.role === "assistant").at(-1);
            const result = this.createTurnResult(input, {
              type: "error",
              stopReason: "model_error",
              usage,
              permissionDenials,
              turns: turnCount,
              startedAt,
              finalMessage,
              errors: [agentError(
                "agent_model_error",
                "The model returned multiple consecutive empty responses. "
                  + "The max output token limit is likely too low — "
                  + "try increasing it so the model has room for visible output after reasoning.",
              )],
            });
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
            await captureTurn(result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
            return { result, messages };
          } else if (!hasAttemptedEmptyRetry) {
            // First occurrence: prompt the model to produce visible output.
            hasAttemptedEmptyRetry = true;
            messages.push({
              role: "user",
              content: [{
                type: "text",
                text: "Your previous response was empty (thinking only, no visible text). "
                  + "Please provide your answer as visible text output.",
              }],
              metadata: { synthetic: true, purpose: "empty_response_retry" },
            });
            yield {
              type: "turn_continued",
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "model_error",
            };
            continue;
          } else {
            // Retry also returned empty — give user a diagnostic hint.
            finalMessage = {
              role: "assistant",
              content: [{
                type: "text",
                text: "[The model returned an empty response. "
                  + "This usually means the max output token limit is too low — "
                  + "the model's reasoning/thinking consumed all available output "
                  + "tokens before producing visible text. "
                  + "Try increasing the max output tokens setting.]",
              }],
            };
            messages.push(finalMessage);
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
            messages.push({
              role: "user",
              content: [{
                type: "text",
                text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing. "
                  + "Pick up mid-sentence if that is where the cut happened.",
              }],
              metadata: { synthetic: true, purpose: "max_output_recovery" },
            });
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
        }

        const largeFileDecision = largeFileRepair.onNoToolCalls();
        if (largeFileDecision) {
          const continued = await continueWithSyntheticPrompt(largeFileDecision);
          if (continued.type === "completed") {
            yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: continued.result.errors![0]! };
            await captureTurn(continued.result.type === "error");
            yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: continued.result };
            return { result: continued.result, messages };
          }
          yield continued.event;
          continue;
        }

        const stopHooks = await this.dispatchLifecycle(input, "Stop", {
          stopHookActive: false,
          lastAssistantMessage: textFromMessage(assembled.message),
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
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
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
      // When jsonrepair silently "fixed" truncated JSON and the response
      // was cut by max_tokens, the tool call arguments are likely incomplete
      // (e.g. half-written file content). Apply the same recovery as
      // max_output_reached: token doubling → continuation prompt → give up.
      if (assembled.hasRepairedToolCalls && (assembled.finishReason === "length" || assembled.finishReason === "tool_call" || assembled.finishReason === "stop")) {
        console.warn(
          `[AgentLoop] Blocking ${toolCalls.length} repaired-but-truncated tool call(s) — entering max_output recovery`,
        );

        const largeFileDecision = largeFileRepair.recoverFromRepairedTruncation(toolCalls);
        if (largeFileDecision) {
          const continued = await continueWithSyntheticPrompt(largeFileDecision);
          if (continued.type === "completed") {
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
          messages = stripTrailingErrorPair(messages);
          const previous = this.config.maxOutputTokens ?? OUTPUT_TOKEN_RETRY_DEFAULT;
          this.config.maxOutputTokens = Math.min(previous * 2, OUTPUT_TOKEN_RETRY_CEILING);
          hasAttemptedOutputRetry = true;
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // Phase B: continuation recovery
        if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          maxOutputRecoveryCount++;
          messages.push({
            role: "user",
            content: [{
              type: "text",
              text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing. "
                + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
            }],
            metadata: { synthetic: true, purpose: "max_output_recovery" },
          });
          yield {
            type: "turn_continued",
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "model_error",
          };
          continue;
        }

        // Phase C: exhausted — let tool execution proceed with
        // outputTruncated=true so formatValidationError can provide hints.
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
          createMissingToolResult(call, this.now, error instanceof Error ? error.message : String(error)),
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

      const pairedResults = ensureToolResultPairing(toolCalls, results, this.now);
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
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      // Circuit breaker: detect turns where ALL tool calls returned
      // invalid_tool_input. If the model is stuck (e.g. repeatedly emitting
      // empty-param bash), terminate early after MAX_CONSECUTIVE_ALL_INVALID_TURNS.
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
        consecutiveAllInvalidTurns++;
        if (consecutiveAllInvalidTurns >= MAX_CONSECUTIVE_ALL_INVALID_TURNS) {
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
              `Terminated: ${consecutiveAllInvalidTurns} consecutive turns with all tool calls failing input validation. The model appears stuck in a loop.`,
              undefined,
              "The model is repeatedly producing invalid tool calls. Consider switching to a more capable model via settings.",
            )],
          });
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          await captureTurn(result.type === "error");
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
      } else {
        consecutiveAllInvalidTurns = 0;
        maxOutputRecoveryCount = 0;
        consecutiveEmptyCount = 0;
        hasAttemptedOutputRetry = false;
        hasAttemptedEmptyRetry = false;
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
        await captureTurn(result.type === "error");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const nextTurnCount = turnCount + 1;
      if (input.maxTurns && nextTurnCount > input.maxTurns) {
        const result = this.createTurnResult(input, {
          type: "max_turns",
          stopReason: "max_turns",
          usage,
          permissionDenials,
          turns: nextTurnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError(
            "agent_max_turns_reached",
            `Reached maximum number of turns (${input.maxTurns}).`,
            undefined,
            "Max turn limit reached. Increase maxTurns in config or break the task into smaller steps.",
          )],
        });
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
    let tools = this.dependencies.tools.registry.toCanonicalSchemas()
      .filter((tool) => !promptBlockedToolNames.has(tool.name));
    if (input.allowPlanModeTools !== true) {
      tools = tools.filter(
        (tool) => tool.name !== "enter_plan_mode" && tool.name !== "exit_plan_mode",
      );
    }
    const prepared = await contextRuntime.prepareForModel({
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages: cloneMessages(messages),
      tools,
      maxMessages: this.config.maxContextMessages,
      customSystemPrompt: this.config.systemPrompt,
      appendSystemPrompt: planTodo?.buildPromptAddendum(),
      abortSignal: input.abortSignal,
    });

    this.dispatchLifecycle(input, "InstructionsLoaded", {
      hasSystemPrompt: !!prepared.systemPrompt,
    }).catch(() => {});
    this.dependencies.eventEmitter?.({
      type: "instructions_loaded",
      sessionId: input.sessionId,
      turnId: input.turnId,
      hasSystemPrompt: !!prepared.systemPrompt,
    });

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
    sudoPolicy?: Partial<SudoPermissionPolicy>,
  ): void {
    if (permissionMode) {
      if (permissionMode === "plan" && this.config.permissionMode !== "plan") {
        this.config.permissionModeBeforePlan = basePermissionMode ?? this.config.permissionMode;
      }
      this.config.permissionMode = permissionMode;
      this.config.permissionContext.mode = permissionMode;
    }
    if (sudoPolicy) {
      this.config.permissionContext.sudoPolicy = normalizeSudoPermissionPolicy(sudoPolicy);
    }
    if (!permissionRules) return;
    mergeUserRules(this.config.permissionContext.rules.allow, permissionRules.allow);
    mergeUserRules(this.config.permissionContext.rules.deny, permissionRules.deny);
    mergeUserRules(this.config.permissionContext.rules.ask, permissionRules.ask);
  }

  private readonly now = (): Date => this.dependencies.now?.() ?? new Date();
}

function mergeUserRules(target: PermissionRule[], userRules: PermissionRule[] | undefined): void {
  const nonUserRules = target.filter((rule) => rule.source !== "user");
  target.splice(0, target.length, ...nonUserRules, ...(userRules ?? []));
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

const OUTPUT_TOKEN_RETRY_DEFAULT = 4_096;
const OUTPUT_TOKEN_RETRY_CEILING = 64_000;

/** Keep only the trailing `keepRatio` portion of the message history. */
function truncateHeadKeepRatio(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  const ratio = Math.max(0.05, Math.min(1, keepRatio));
  const keep = Math.max(1, Math.floor(messages.length * ratio));
  return messages.slice(-keep);
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
