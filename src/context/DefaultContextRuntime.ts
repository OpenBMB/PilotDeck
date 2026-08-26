import type { CanonicalMessage } from "../model/index.js";
import { ToolResultBudget } from "./budget/ToolResultBudget.js";
import type { TokenBudgetManager, TokenBudgetSnapshot } from "./budget/TokenBudgetManager.js";
import type { AutoCompactionPolicy } from "./compaction/AutoCompactionPolicy.js";
import {
  type CompactionEngine,
  type CompactionResult,
  buildPostCompactMessages,
  truncateHeadPreservingCheckpoint,
} from "./compaction/CompactionEngine.js";
import { buildCachePlan } from "./cache/CachePlan.js";
import type { MicroCompactionEngine } from "./compaction/MicroCompactionEngine.js";
import type { SnipEngine } from "./compaction/SnipEngine.js";
import { ensureTrailingUserMessage } from "./compaction/toolPairIntegrity.js";
import type { ContextOverflowRecovery } from "./recovery/ContextOverflowRecovery.js";
import { NullExtensionResolver, type ExtensionResolver } from "./extension/ExtensionResolver.js";
import type { InstructionDiscovery, InstructionScope } from "./instructions/InstructionDiscovery.js";
import { MemoryAttachmentBuilder } from "./memory/MemoryAttachmentBuilder.js";
import type { MemoryResolver } from "./memory/MemoryResolver.js";
import { PromptAssembler } from "./prompt/PromptAssembler.js";
import { MessageProjector } from "./projection/MessageProjector.js";
import type {
  ContextCaptureTurnInput,
  ContextDiagnostic,
  ContextPrepareInput,
  ContextRecoveryDecision,
  ContextRecoveryInput,
  ContextRuntime,
  ContextToolResultInput,
  ContextToolResultResult,
  ModelContext,
} from "./protocol/types.js";

export type CompactionTier = "micro" | "snip" | "full" | "emergency";

export type AutoCompactResult =
  | { type: "skipped"; snapshot: TokenBudgetSnapshot }
  | {
      type: "compacted";
      messages: CanonicalMessage[];
      tier: CompactionTier;
      snapshot: TokenBudgetSnapshot;
      result?: CompactionResult;
      /** Set when every emergency tier ran but the request still cannot fit. */
      error?: "context_overflow_after_emergency_compaction";
    };

export type DefaultContextRuntimeOptions = {
  extension?: ExtensionResolver;
  promptAssembler?: PromptAssembler;
  messageProjector?: MessageProjector;
  toolResultBudget?: ToolResultBudget;
  memoryResolver?: MemoryResolver;
  /** A2 — token budget manager (provider-aware tokenizer fallback). */
  tokenBudget?: TokenBudgetManager;
  /** A5 — full-conversation compaction engine (summarize via model call). */
  compactionEngine?: CompactionEngine;
  /** A5 — token-budget-driven policy that decides when to summarize. */
  autoCompactionPolicy?: AutoCompactionPolicy;
  /** Tier 1 — truncates old tool_result content (time-based path). */
  microCompaction?: MicroCompactionEngine;
  /** Tier 2 — prunes middle turns, keeping head + tail anchors. */
  snipEngine?: SnipEngine;
  /** Reactive overflow recovery (prompt_too_long → truncate head). */
  overflowRecovery?: ContextOverflowRecovery;
  /** PILOTDECK.md instruction file discovery (multi-scope hierarchy). */
  instructionDiscovery?: InstructionDiscovery;
  /** Project root forwarded to MemoryResolver.retrieve. */
  projectRoot?: string;
  /**
   * Maximum context window size (tokens) for the active model. Used by
   * `tryAutoCompact` to evaluate whether proactive compaction is needed.
   * Falls back to 8192 when unset.
   */
  maxContextTokens?: number;
  /**
   * keepRatio used on the first reactive truncate. Legacy hint is 0.5 — keep
   * the back half of the conversation. Decision §3.2.
   */
  truncateFirstKeepRatio?: number;
  /** Aggressive ratio used after one truncate-and-retry already failed. */
  truncateSecondKeepRatio?: number;
  /** Timeout budget for MemoryResolver.retrieve during prepareForModel. */
  memoryRetrievalTimeoutMs?: number;
  now?: () => Date;
};

const DEFAULT_MAX_CONTEXT_TOKENS = 8192;
const DEFAULT_TRUNCATE_FIRST_RATIO = 0.5;
const DEFAULT_TRUNCATE_SECOND_RATIO = 0.25;
const DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 30_000;
const POST_COMPACTION_TARGET_RATIO = 0.60;
// Keep the emergency tail at the lower end of the plan's 5%-10% range. This
// matches the previous relaxed compaction behaviour and leaves enough room
// for large, stable system/tool definitions in small model contexts.
const EMERGENCY_KEEP_TAIL_RATIO = 0.05;
const EMERGENCY_SUMMARY_MAX_OUTPUT_TOKENS = 1_536;
const EMERGENCY_TOOL_RESULT_TOKENS = 256;
const EMERGENCY_HEAD_KEEP_RATIO = 0.10;

export class DefaultContextRuntime implements ContextRuntime {
  private readonly extension: ExtensionResolver;
  private readonly promptAssembler: PromptAssembler;
  private readonly messageProjector: MessageProjector;
  private readonly toolResultBudget?: ToolResultBudget;
  private readonly memoryResolver?: MemoryResolver;
  private readonly memoryAttachmentBuilder?: MemoryAttachmentBuilder;
  readonly tokenBudget?: TokenBudgetManager;
  readonly compactionEngine?: CompactionEngine;
  readonly autoCompactionPolicy?: AutoCompactionPolicy;
  private readonly cachePlanState = new Map<string, { fingerprint: string; generation: number }>();
  private readonly cacheResetSessions = new Set<string>();
  private readonly microCompaction?: MicroCompactionEngine;
  private readonly snipEngine?: SnipEngine;
  private readonly overflowRecovery?: ContextOverflowRecovery;
  private readonly instructionDiscovery?: InstructionDiscovery;
  private readonly projectRoot?: string;
  private readonly maxContextTokens: number;
  private readonly truncateFirstKeepRatio: number;
  private readonly truncateSecondKeepRatio: number;
  private readonly memoryRetrievalTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: DefaultContextRuntimeOptions = {}) {
    this.extension = options.extension ?? new NullExtensionResolver();
    this.promptAssembler = options.promptAssembler ?? new PromptAssembler(this.extension);
    this.messageProjector = options.messageProjector ?? new MessageProjector();
    this.toolResultBudget = options.toolResultBudget;
    this.memoryResolver = options.memoryResolver;
    this.memoryAttachmentBuilder = options.memoryResolver
      ? new MemoryAttachmentBuilder(options.memoryResolver)
      : undefined;
    this.tokenBudget = options.tokenBudget;
    this.compactionEngine = options.compactionEngine;
    this.autoCompactionPolicy = options.autoCompactionPolicy;
    this.microCompaction = options.microCompaction;
    this.snipEngine = options.snipEngine;
    this.overflowRecovery = options.overflowRecovery;
    this.instructionDiscovery = options.instructionDiscovery;
    this.projectRoot = options.projectRoot;
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.truncateFirstKeepRatio = options.truncateFirstKeepRatio ?? DEFAULT_TRUNCATE_FIRST_RATIO;
    this.truncateSecondKeepRatio = options.truncateSecondKeepRatio ?? DEFAULT_TRUNCATE_SECOND_RATIO;
    this.memoryRetrievalTimeoutMs = options.memoryRetrievalTimeoutMs ?? DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async prepareForModel(input: ContextPrepareInput): Promise<ModelContext> {
    const diagnostics: ContextDiagnostic[] = [];

    const projection = this.messageProjector.project({
      messages: input.messages,
      maxMessages: input.maxMessages,
    });

    for (const warning of projection.warnings) {
      diagnostics.push({
        code: warning.code,
        severity: "warning",
        message: warning.message,
      });
    }

    const prompt = this.promptAssembler.assemble({
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      permissionMode: input.permissionMode,
      runMode: input.runMode,
      additionalWorkingDirectories: input.additionalWorkingDirectories,
      tools: input.tools,
      customSystemPrompt: input.customSystemPrompt,
      appendSystemPrompt: input.appendSystemPrompt,
      now: this.now,
    });

    const parts = [...prompt.parts];
    if (this.memoryAttachmentBuilder) {
      const memory = await this.memoryAttachmentBuilder.build({
        query: extractRecentUserText(projection.messages) ?? "",
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? input.cwd,
        recentMessages: projection.messages,
        signal: input.abortSignal,
        timeoutMs: this.memoryRetrievalTimeoutMs,
      });
      for (const block of memory.attachments) {
        for (const content of block.content) {
          if (content.type === "text" && content.text.trim().length > 0) {
            parts.push(content.text);
          }
        }
      }
      for (const diagnostic of memory.diagnostics) {
        diagnostics.push({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
        });
      }
      if (input.abortSignal?.aborted) {
        return {
          messages: projection.messages,
          systemPrompt: parts.join("\n\n"),
          systemPromptParts: parts,
          tools: input.tools,
          diagnostics,
          boundaries: [],
          metadata: {
            droppedCount: projection.droppedCount,
            toolCount: input.tools.length,
          },
        };
      }
    }

    if (this.instructionDiscovery) {
      try {
        const layers = await this.instructionDiscovery.discover();
        if (layers.length > 0) {
          const blocks = layers.map(l => {
            const desc = instructionScopeDescription(l.scope);
            return `Contents of ${l.path}${desc}:\n\n${l.content}`;
          });
          parts.push(
            `<project-instructions>\nProject instructions are shown below. Adhere to these instructions. ` +
            `IMPORTANT: These instructions OVERRIDE any default behavior.\n\n` +
            `${blocks.join("\n\n")}\n</project-instructions>`,
          );
        }
      } catch {
        diagnostics.push({
          code: "instruction_discovery_failed",
          severity: "warning",
          message: "Failed to discover PILOTDECK.md instruction files.",
        });
      }
    }

    const joined = parts.join("\n\n");

    const cachePlanInput = {
      provider: input.provider,
      model: input.model,
      systemPrompt: joined,
      tools: input.tools,
      messages: projection.messages,
      enabled: input.protocol === "anthropic" && input.supportsPromptCache === true,
    };
    const cachePlanFingerprint = buildCachePlan(cachePlanInput, 0)?.fingerprint;
    const cachePlan = buildCachePlan(
      cachePlanInput,
      this.nextCachePlanGeneration(
        input.sessionId,
        cachePlanFingerprint,
        this.cacheResetSessions.delete(input.sessionId),
      ),
    );

    return {
      messages: projection.messages,
      systemPrompt: joined,
      systemPromptParts: parts,
      tools: input.tools,
      diagnostics,
      boundaries: [],
      metadata: {
        droppedCount: projection.droppedCount,
        toolCount: input.tools.length,
      },
      cacheBreakpoints: cachePlan?.messages,
      cachePlan,
    };
  }

  private nextCachePlanGeneration(sessionId: string, fingerprint: string | undefined, forceReset = false): number {
    const previous = this.cachePlanState.get(sessionId);
    if (!fingerprint) return previous?.generation ?? 0;
    if (forceReset || fingerprint !== previous?.fingerprint) {
      const generation = (previous?.generation ?? 0) + 1;
      this.cachePlanState.set(sessionId, { fingerprint, generation });
      return generation;
    }
    return previous.generation;
  }

  private markCachePlanReset(sessionId: string): void {
    if (sessionId) this.cacheResetSessions.add(sessionId);
  }

  async applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult> {
    const diagnostics: ContextDiagnostic[] = [];
    let appended: CanonicalMessage = input.toolResultMessage;
    let supplementalMessages = input.supplementalMessages ?? [];
    if (this.toolResultBudget) {
      try {
        appended = await this.toolResultBudget.applyToMessage(input.toolResultMessage, { turnId: input.turnId });
        supplementalMessages = await Promise.all(
          supplementalMessages.map(async ({ toolCallId, message }) => ({
            toolCallId,
            message: await this.toolResultBudget!.applyToSupplementalMessage(
              message,
              toolCallId,
              { turnId: input.turnId },
            ),
          })),
        );
      } catch (error) {
        diagnostics.push({
          code: "tool_result_persistence_failed",
          severity: "error",
          message: `Failed to persist large tool result: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const appendedMessages = [appended, ...supplementalMessages.map(({ message }) => message)];
    return { messages: [...input.messages, ...appendedMessages], appendedMessages, diagnostics };
  }

  async captureTurn(input: ContextCaptureTurnInput): Promise<void> {
    if (!this.memoryResolver) return;
    if (isAlwaysOnSession(input.sessionId)) return;
    try {
      await this.memoryResolver.captureTurn({
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? "",
        messages: input.messages.filter((message) => !message.metadata?.forkCarryover),
        errored: input.errored,
      });
    } catch {
      // Memory capture must never break the agent turn — provider already
      // swallows in EdgeClawMemoryProvider, this catch is belt-and-suspenders.
    }
  }

  async tryAutoCompact(input: {
    sessionId?: string;
    turnId?: string;
    messages: CanonicalMessage[];
    abortSignal?: AbortSignal;
    maxContextTokens?: number;
    reservedOutputTokens?: number;
    allowFallbackOnFailure?: boolean;
    budgetEvaluator?: (messages: CanonicalMessage[]) => Promise<TokenBudgetSnapshot>;
  }): Promise<AutoCompactResult> {
    const sessionId = input.sessionId ?? "";
    const turnId = input.turnId ?? "";
    const log = (stage: string, details: Record<string, unknown> = {}) => {
      logAutoCompactEvent(stage, { sessionId, turnId }, details);
    };
    const effectiveMaxContextTokens = input.maxContextTokens ?? this.maxContextTokens;
    if (!this.autoCompactionPolicy || !this.tokenBudget) {
      log("disabled", {
        hasAutoCompactionPolicy: Boolean(this.autoCompactionPolicy),
        hasTokenBudget: Boolean(this.tokenBudget),
        maxContextTokens: effectiveMaxContextTokens,
      });
      return {
        type: "skipped",
        snapshot: {
          tokens: 0,
          maxContextTokens: effectiveMaxContextTokens,
          warningRatio: 0,
          blockingRatio: 0,
          state: "ok",
          ratio: 0,
        },
      };
    }
    let messages = input.messages;
    const budgetOptions = { reservedOutputTokens: input.reservedOutputTokens };
    const evaluateBudget = (candidate: CanonicalMessage[]) =>
      input.budgetEvaluator
        ? input.budgetEvaluator(candidate)
        : Promise.resolve(this.tokenBudget!.evaluate(candidate, effectiveMaxContextTokens, {
            ...budgetOptions,
          }));
    const initialSnapshot = await evaluateBudget(messages);
    let currentSnapshot = initialSnapshot;
    const decision = this.autoCompactionPolicy.evaluateSnapshot(initialSnapshot);
    if (decision.type !== "trigger") {
      log("policy_skip", {
        decisionType: decision.type,
        snapshot: describeTokenBudgetSnapshot(decision.snapshot),
      });
      return { type: "skipped", snapshot: decision.snapshot };
    }
    log("policy_trigger", {
      reason: decision.reason,
      snapshot: describeTokenBudgetSnapshot(initialSnapshot),
      messages: messages.length,
      reservedOutputTokens: input.reservedOutputTokens,
    });

    // 80% pressure: deterministic, whitelist-only tool-result projection.
    if (this.microCompaction) {
      const micro = this.microCompaction.apply({ messages, trimToTokens: 768 });
      messages = micro.messages;
      const microSnapshot = await evaluateBudget(messages);
      currentSnapshot = microSnapshot;
      log("pre_summary_prune", {
        rewritten: micro.rewritten,
        rewrittenBytes: micro.rewrittenBytes,
        snapshot: describeTokenBudgetSnapshot(microSnapshot),
      });
      if (microSnapshot.ratio < 0.90) {
        if (micro.rewritten === 0) {
          return { type: "skipped", snapshot: microSnapshot };
        }
        this.markCachePlanReset(sessionId);
        return {
          type: "compacted",
          messages: ensureTrailingUserMessage(messages),
          tier: "micro",
          snapshot: microSnapshot,
        };
      }
    }

    // A warning-level context is usable after the deterministic phase. This
    // guard also preserves the 80%-90% no-summary contract when a caller did
    // not configure a micro-compaction engine.
    if (currentSnapshot.ratio < 0.90) {
      return { type: "skipped", snapshot: currentSnapshot };
    }

    if (!this.compactionEngine) {
      log("full_compaction_unavailable", { snapshot: describeTokenBudgetSnapshot(currentSnapshot) });
      return { type: "skipped", snapshot: currentSnapshot };
    }

    log("full_compaction_started", {
      messages: messages.length,
      snapshot: describeTokenBudgetSnapshot(currentSnapshot),
    });
    const effectiveContextTokens = Math.max(
      1,
      Math.floor(currentSnapshot.effectiveContextTokens ?? currentSnapshot.maxContextTokens),
    );
    const targetPostTokens = Math.max(1, Math.floor(effectiveContextTokens * POST_COMPACTION_TARGET_RATIO));
    const result = await this.compactionEngine.run({
      trigger: "auto",
      messages,
      effectiveContextTokens,
      targetPostTokens,
      signal: input.abortSignal,
      sessionId,
      turnId,
    });
    const summarySucceeded = compactionSummarySucceeded(result);
    if (result.error) {
      log("full_compaction_no_summary", { error: result.error, preTokens: result.preTokens });
    } else if (!result.summaryMessage) {
      // A protected early turn can legitimately leave the normal summary
      // prefix empty. That is not a successful compaction: keep going through
      // post-summary snip and the emergency tiers instead of sending the
      // unchanged oversized transcript to the model.
      log("full_compaction_no_summary", {
        reason: "no_summarizable_live_turns",
        preTokens: result.preTokens,
      });
    }

    let finalResult: CompactionResult | undefined = summarySucceeded ? result : undefined;
    let postMessages = summarySucceeded
      ? ensureTrailingUserMessage(buildPostCompactMessages(result))
      : messages;
    // A failed summary leaves the transcript byte-for-byte unchanged. Recount
    // that same request before deciding whether the 90% emergency tier is needed.
    let snapshot = await evaluateBudget(postMessages);
    let snipApplied = false;
    if (summarySucceeded && snapshot.ratio > POST_COMPACTION_TARGET_RATIO && this.snipEngine) {
      const messageTokens = this.tokenBudget?.estimateMessagesTokens(postMessages);
      const nonMessageTokens = messageTokens === undefined
        ? 0
        : Math.max(0, snapshot.tokens - messageTokens);
      const messageTarget = Math.max(1, targetPostTokens - nonMessageTokens);
      const snipTargetTokens = messageTokens !== undefined
        ? Math.min(messageTokens, messageTarget)
        : targetPostTokens;
      const snip = this.snipEngine.snip(postMessages, {
        targetTotalTokens: snipTargetTokens,
      });
      postMessages = snip.messages;
      snapshot = await evaluateBudget(postMessages);
      snipApplied = snip.applied;
      log("post_summary_snip", {
        applied: snip.applied,
        turnsSnipped: snip.turnsSnipped,
        targetPostTokens,
        snipTargetTokens,
        snapshot: describeTokenBudgetSnapshot(snapshot),
      });
    }

    let emergencyApplied = false;
    if (snapshot.ratio >= 0.90) {
      const emergency = await this.runEmergencyCompaction({
        messages: postMessages,
        input,
        evaluateBudget,
        effectiveContextTokens,
        targetPostTokens,
        sessionId,
        turnId,
        log,
      });
      if (emergency) {
        emergencyApplied = emergency.changed;
        finalResult = emergency.result ?? finalResult;
        postMessages = emergency.messages;
        snapshot = emergency.snapshot;
        if (emergency.diagnostics && finalResult) {
          finalResult.diagnostics.push(...emergency.diagnostics);
        }
      }
    }

    const overflowAfterEmergency = snapshot.ratio >= 1;
    if (!summarySucceeded && !snipApplied && !emergencyApplied && !overflowAfterEmergency) {
      log("full_compaction_skipped", {
        reason: "no_effective_change",
        targetPostTokens,
        snapshot: describeTokenBudgetSnapshot(currentSnapshot),
      });
      return { type: "skipped", snapshot: currentSnapshot };
    }

    if (snapshot.ratio > POST_COMPACTION_TARGET_RATIO && finalResult) {
      finalResult.diagnostics.push({
        code: "compaction_target_not_reached",
        severity: "warning",
        message:
          `Compaction remained above the ${Math.round(POST_COMPACTION_TARGET_RATIO * 100)}% target ` +
          `(tokens=${snapshot.tokens}, target=${targetPostTokens}, ratio=${snapshot.ratio.toFixed(3)}). ` +
          "Protected checkpoints, tool turns, or the required recent tail may account for the remainder.",
      });
    }

    log("full_compaction_completed", {
      snapshot: describeTokenBudgetSnapshot(snapshot),
      summarySucceeded: finalResult ? compactionSummarySucceeded(finalResult) : false,
      summaryGenerated: finalResult?.summaryGenerated === true,
      checkpointMerged: finalResult?.checkpointMerged === true,
      targetPostTokens,
      preTokens: finalResult?.preTokens ?? result.preTokens,
      postTokens: finalResult?.postTokens,
    });
    if (summarySucceeded || snipApplied || emergencyApplied) {
      this.markCachePlanReset(sessionId);
    }
    // 90% is the protection threshold that triggers emergency work, not a
    // hard provider overflow. If the final prompt is still below the actual
    // effective input budget, it remains sendable and should not be converted
    // into a fatal context error merely because static tool definitions consume
    // the remaining safety margin.
    if (overflowAfterEmergency) {
      const diagnostic: ContextDiagnostic = {
        code: "context_overflow_after_emergency_compaction",
        severity: "error",
        message:
          `Context remains over the effective input budget after emergency compaction ` +
          `(tokens=${snapshot.tokens}, max=${snapshot.maxContextTokens}, ratio=${snapshot.ratio.toFixed(3)}). ` +
          "The stable checkpoint, current request, tool protocol, and required tail are the remaining sources.",
      };
      finalResult?.diagnostics.push(diagnostic);
      log("context_overflow_after_emergency_compaction", {
        snapshot: describeTokenBudgetSnapshot(snapshot),
        diagnostic: diagnostic.message,
      });
    }
    return {
      type: "compacted",
      messages: postMessages,
      tier: snapshot.ratio >= 0.90 ? "emergency" : "full",
      snapshot,
      ...(finalResult ? { result: finalResult } : {}),
      ...(overflowAfterEmergency ? { error: "context_overflow_after_emergency_compaction" as const } : {}),
    };
  }

  private async runEmergencyCompaction(options: {
    messages: CanonicalMessage[];
    input: { abortSignal?: AbortSignal };
    evaluateBudget: (messages: CanonicalMessage[]) => Promise<TokenBudgetSnapshot>;
    effectiveContextTokens: number;
    targetPostTokens: number;
    sessionId: string;
    turnId: string;
    log: (stage: string, details?: Record<string, unknown>) => void;
  }): Promise<{
    messages: CanonicalMessage[];
    snapshot: TokenBudgetSnapshot;
    changed: boolean;
    result?: CompactionResult;
    diagnostics?: ContextDiagnostic[];
  } | undefined> {
    let messages = options.messages;
    let snapshot = await options.evaluateBudget(messages);
    let changed = false;
    let emergencyResult: CompactionResult | undefined;
    if (snapshot.ratio < 0.90) return { messages, snapshot, changed };

    // Emergency summary is the only normal path allowed to rewrite the
    // checkpoint prefix. It is intentionally short and marked as a cache reset.
    if (this.compactionEngine) {
      emergencyResult = await this.compactionEngine.run({
        trigger: "reactive",
        messages,
        keepTailRatio: EMERGENCY_KEEP_TAIL_RATIO,
        effectiveContextTokens: options.effectiveContextTokens,
        targetPostTokens: options.targetPostTokens,
        protectedToolNames: null,
        maxOutputTokens: EMERGENCY_SUMMARY_MAX_OUTPUT_TOKENS,
        cacheReset: true,
        signal: options.input.abortSignal,
        sessionId: options.sessionId,
        turnId: options.turnId,
      });
      if (emergencyResult.summaryMessage && emergencyResult.error === undefined) {
        messages = ensureTrailingUserMessage(buildPostCompactMessages({
          ...emergencyResult,
          cacheReset: true,
          stablePrefix: [],
        }));
        changed = true;
        snapshot = await options.evaluateBudget(messages);
        options.log("emergency_summary", {
          snapshot: describeTokenBudgetSnapshot(snapshot),
          cacheReset: true,
        });
        if (snapshot.ratio < 0.90) return { messages, snapshot, changed, result: emergencyResult };
      }
    }

    const persistedEmergencyResult = emergencyResult?.summaryMessage && emergencyResult.error === undefined
      ? emergencyResult
      : undefined;
    const projected = this.microCompaction?.apply({
      messages,
      trimToTokens: EMERGENCY_TOOL_RESULT_TOKENS,
      keepLatest: 1,
      protectedToolNames: null,
    });
    if (projected) {
      messages = projected.messages;
      changed ||= projected.rewritten > 0;
      snapshot = await options.evaluateBudget(messages);
      options.log("emergency_tool_projection", {
        rewritten: projected.rewritten,
        snapshot: describeTokenBudgetSnapshot(snapshot),
      });
      if (snapshot.ratio < 0.90) {
        return {
          messages,
          snapshot,
          changed,
          result: persistedEmergencyResult,
        };
      }
    }

    const truncated = truncateHeadPreservingCheckpoint(messages, EMERGENCY_HEAD_KEEP_RATIO);
    changed ||= !sameMessageSequence(messages, truncated);
    messages = truncated;
    snapshot = await options.evaluateBudget(messages);
    const diagnostics: ContextDiagnostic[] = [{
      code: "context_hard_truncate",
      severity: "error",
      message:
        `Emergency head truncation kept approximately ${Math.round(EMERGENCY_HEAD_KEEP_RATIO * 100)}% ` +
        `of the live history (tokens=${snapshot.tokens}, max=${snapshot.maxContextTokens}). ` +
        "Earlier live turns may be unavailable outside the durable transcript.",
    }];
    options.log("emergency_head_truncate", {
      snapshot: describeTokenBudgetSnapshot(snapshot),
      keepRatio: EMERGENCY_HEAD_KEEP_RATIO,
    });
    return {
      messages,
      snapshot,
      changed,
      result: persistedEmergencyResult,
      diagnostics,
    };
  }

  async recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision> {
    if (this.overflowRecovery) {
      return this.overflowRecovery.decide(input);
    }
    // Fallback: inline logic when no ContextOverflowRecovery is injected.
    if (input.error.recoverableViaImageStrip) {
      return {
        type: "strip_images_and_retry",
        reason: "multimodal-processor-error",
      };
    }
    if (input.error.code === "image_too_large") {
      return {
        type: "strip_images_and_retry",
        reason: "image-too-large",
      };
    }
    const isContextError =
      input.error.code === "prompt_too_long" ||
      input.error.code === "context_overflow" ||
      input.error.recoverableViaCompact === true;
    if (!isContextError) {
      return {
        type: "give_up",
        reason: `non_recoverable_model_error:${input.error.code}`,
      };
    }
    if (input.hasAttemptedCompact) {
      return {
        type: "give_up",
        reason: "ptl-exhausted-after-two-attempts",
      };
    }
    return {
      type: "truncate_head_and_retry",
      keepRatio: this.truncateFirstKeepRatio,
      reason: "ptl-first-attempt",
    };
  }
}

function isAlwaysOnSession(sessionId: string): boolean {
  return [
    "always-on/discovery:",
    "always-on/workspace:",
    "always-on/execute:",
    "always-on/report:",
    "always-on/apply:",
  ].some((prefix) => sessionId.startsWith(prefix));
}

function instructionScopeDescription(scope: InstructionScope): string {
  switch (scope) {
    case "managed":
      return " (managed instructions, set by administrator)";
    case "user":
      return " (user's global instructions for all projects)";
    case "project":
      return " (project instructions, checked into the codebase)";
    case "project-rules":
      return " (project rule, checked into the codebase)";
    case "local":
      return " (user's private project instructions, not checked in)";
  }
}

function extractRecentUserText(messages: CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        return block.text;
      }
    }
  }
  return undefined;
}

function sameMessageSequence(left: CanonicalMessage[], right: CanonicalMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function logAutoCompactEvent(
  stage: string,
  context: { sessionId?: string; turnId?: string },
  details: Record<string, unknown>,
): void {
  const payload = {
    sessionId: context.sessionId ?? "",
    turnId: context.turnId ?? "",
    ...details,
  };
  try {
    console.warn(`[context:auto-compact] ${stage} ${JSON.stringify(payload)}`);
  } catch {
    console.warn(`[context:auto-compact] ${stage}`);
  }
}

function describeTokenBudgetSnapshot(snapshot: TokenBudgetSnapshot): Record<string, unknown> {
  return {
    tokens: snapshot.tokens,
    displayTokens: snapshot.displayTokens,
    estimateSource: snapshot.estimateSource,
    usageTokens: snapshot.usageTokens,
    localEstimateTokens: snapshot.localEstimateTokens,
    calibrationActualInputTokens: snapshot.calibrationActualInputTokens,
    calibrationEstimatedInputTokens: snapshot.calibrationEstimatedInputTokens,
    totalContextTokens: snapshot.totalContextTokens,
    maxContextTokens: snapshot.maxContextTokens,
    effectiveContextTokens: snapshot.effectiveContextTokens,
    maxOutputTokens: snapshot.maxOutputTokens,
    warningRatio: snapshot.warningRatio,
    blockingRatio: snapshot.blockingRatio,
    state: snapshot.state,
    ratio: snapshot.ratio,
    source: snapshot.source,
    exact: snapshot.exact,
    reservedOutputTokens: snapshot.reservedOutputTokens,
  };
}

function compactionSummarySucceeded(result: CompactionResult): boolean {
  return result.error === undefined
    && result.summaryMessage !== undefined;
}
