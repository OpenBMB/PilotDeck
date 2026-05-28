import type { CanonicalMessage } from "../model/index.js";
import { ToolResultBudget } from "./budget/ToolResultBudget.js";
import type { TokenBudgetManager, TokenBudgetSnapshot } from "./budget/TokenBudgetManager.js";
import type { AutoCompactionPolicy } from "./compaction/AutoCompactionPolicy.js";
import {
  type CompactionEngine,
  type CompactionResult,
  buildPostCompactMessages,
} from "./compaction/CompactionEngine.js";
import type { CachedMicroCompactionEngine } from "./compaction/CachedMicroCompactionEngine.js";
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

export type CompactionTier = "micro" | "snip" | "full";

export type AutoCompactResult =
  | { type: "skipped"; snapshot: TokenBudgetSnapshot }
  | {
      type: "compacted";
      messages: CanonicalMessage[];
      tier: CompactionTier;
      snapshot: TokenBudgetSnapshot;
      result?: CompactionResult;
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
  /**
   * A4 — opt-in cached micro-compaction engine. Construction is gated by
   * `PilotConfig.context.cachedMicrocompactEnabled` upstream.
   */
  microcompactEngine?: CachedMicroCompactionEngine;
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
const DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 5_000;

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
  readonly microcompactEngine?: CachedMicroCompactionEngine;
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
    this.microcompactEngine = options.microcompactEngine;
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

    const microcompactResult = this.microcompactEngine?.apply({
      messages: projection.messages,
    });

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
      cacheBreakpoints: microcompactResult?.cacheBreakpoints,
    };
  }

  async applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult> {
    const diagnostics: ContextDiagnostic[] = [];
    let appended: CanonicalMessage = input.toolResultMessage;
    if (this.toolResultBudget) {
      try {
        appended = await this.toolResultBudget.applyToMessage(input.toolResultMessage);
      } catch (error) {
        diagnostics.push({
          code: "tool_result_persistence_failed",
          severity: "error",
          message: `Failed to persist large tool result: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { messages: [...input.messages, appended], diagnostics };
  }

  async captureTurn(input: ContextCaptureTurnInput): Promise<void> {
    if (!this.memoryResolver) return;
    try {
      await this.memoryResolver.captureTurn({
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? "",
        messages: input.messages,
        errored: input.errored,
      });
    } catch {
      // Memory capture must never break the agent turn — provider already
      // swallows in EdgeClawMemoryProvider, this catch is belt-and-suspenders.
    }
  }

  async tryAutoCompact(input: {
    messages: CanonicalMessage[];
    abortSignal?: AbortSignal;
    maxContextTokens?: number;
  }): Promise<AutoCompactResult> {
    const effectiveMaxContextTokens = input.maxContextTokens ?? this.maxContextTokens;
    if (!this.autoCompactionPolicy || !this.tokenBudget) {
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
    const decision = this.autoCompactionPolicy.evaluate(messages, effectiveMaxContextTokens);
    if (decision.type !== "trigger") {
      return { type: "skipped", snapshot: decision.snapshot };
    }

    // Tier 1: MicroCompaction — truncate old tool_result content.
    if (this.microCompaction) {
      const r = this.microCompaction.apply({ messages });
      if (r.rewritten > 0) {
        messages = r.messages;
        const snap = this.tokenBudget.evaluate(messages, effectiveMaxContextTokens);
        if (snap.state === "ok") {
          return {
            type: "compacted",
            messages: ensureTrailingUserMessage(messages),
            tier: "micro",
            snapshot: snap,
          };
        }
      }
    }

    // Tier 2: SnipEngine — prune middle turns, keep head + tail.
    if (this.snipEngine) {
      const r = this.snipEngine.snip(messages);
      if (r.applied) {
        messages = r.messages;
        const snap = this.tokenBudget.evaluate(messages, effectiveMaxContextTokens);
        if (snap.state === "ok") {
          return {
            type: "compacted",
            messages: ensureTrailingUserMessage(messages),
            tier: "snip",
            snapshot: snap,
          };
        }
      }
    }

    // Tier 3: CompactionEngine — full summarization via model call.
    if (this.compactionEngine) {
      const result = await this.compactionEngine.run({
        trigger: "auto",
        messages,
        signal: input.abortSignal,
      });
      const postCompactMessages = ensureTrailingUserMessage(buildPostCompactMessages(result));
      const snapshot = this.tokenBudget.evaluate(postCompactMessages, effectiveMaxContextTokens);
      return {
        type: "compacted",
        messages: postCompactMessages,
        tier: "full",
        snapshot,
        result,
      };
    }

    return { type: "skipped", snapshot: decision.snapshot };
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
    if (input.error.code !== "prompt_too_long") {
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
