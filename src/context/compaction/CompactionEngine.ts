import type {
  CanonicalContentBlock,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalToolCallBlock,
  CanonicalToolResultBlock,
  CanonicalToolResultReferenceBlock,
  CanonicalUsage,
} from "../../model/index.js";
import { flattenToolResultContentText } from "../../model/index.js";
import { createHash, randomUUID } from "node:crypto";
import type { TokenAccountingRuntime } from "../budget/TokenAccountingRuntime.js";
import { TokenBudgetManager } from "../budget/TokenBudgetManager.js";
import type { ContextDiagnostic } from "../protocol/types.js";
import { stripMultimediaFromMessages } from "./stripMultimedia.js";
import {
  collectToolCallIds,
  collectToolResultIds,
  ensureTrailingUserMessage,
  stripUnpairedToolCalls,
  stripUnpairedToolResults,
} from "./toolPairIntegrity.js";
import type { AgentEventEmitter } from "../../agent/protocol/events.js";
import {
  collectToolNamesByCallId,
  isProtectedContextMessage,
  protectedToolNameSet,
  splitMessagesIntoTurns,
} from "./protectedContext.js";

export type CompactionTrigger = "manual" | "auto" | "reactive";

export type CompactionEngineOptions = {
  /**
   * AgentLoop-supplied model runtime. CompactionEngine **does not** sit inside
   * `ContextRuntime`; the loop owns this dependency (decision §3.2).
   */
  model: { stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> };
  tokenBudget?: TokenBudgetManager;
  tokenAccounting?: TokenAccountingRuntime;
  /** Optional lifecycle dispatcher (PreCompact / PostCompact). */
  lifecycle?: {
    dispatch(input: { event: "PreCompact" | "PostCompact"; payload: Record<string, unknown> }): void | Promise<void>;
  };
  /** Provider id forwarded to `stream()`. */
  provider: string;
  /** Model id forwarded to `stream()`. */
  model_: string;
  /** Optional summary system prompt base; the runtime always appends its summary rubric and safety constraints. */
  systemPrompt?: string;
  /** Max output tokens for the summary call (legacy default 20_000). */
  maxOutputTokens?: number;
  /** Tool names whose turns should be preserved verbatim across full compaction. */
  protectedToolNames?: Iterable<string>;
  now?: () => Date;
  /** Stable identity factory for correlating live and persisted compaction events. */
  uuid?: () => string;
  eventEmitter?: AgentEventEmitter;
};

export const COMPACT_SYSTEM_PROMPT_DEFAULT =
  "You are a conversation summarizer for a coding agent. Your summary will replace " +
  "the early conversation history, so it MUST preserve all information the agent " +
  "needs to continue working without repeating past steps.";
// Keep room for the summary input inside small configured contexts such as
// agent.maxContextTokens: 20_000.
export const COMPACT_MAX_OUTPUT_TOKENS = 4_000;

const SUMMARY_MARKDOWN_HEADINGS = [
  "Objective",
  "Current State",
  "Completed",
  "Remaining",
  "Decisions",
  "Files And Artifacts",
  "Tool Findings",
  "Errors And Recovery",
  "Open Questions",
] as const;

const CORE_SUMMARY_MARKDOWN_HEADINGS = [
  "Objective",
  "Current State",
  "Remaining",
  "Files And Artifacts",
] as const;

const COMPACT_SUMMARY_SYSTEM_PROMPT_DEFAULT = buildMarkdownSummarySystemPrompt(COMPACT_SYSTEM_PROMPT_DEFAULT);

const COMPACT_SUMMARY_ANCHOR_MAX_ITEMS = 12;
const COMPACT_SUMMARY_ANCHOR_MAX_INPUT_CHARS = 2_000;
const COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS = 1_200;
const COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS = 600;
const COMPACT_SUMMARY_ANCHOR_MAX_TOTAL_CHARS = 16_000;
const COMPACT_SUMMARY_FAILURE_COOLDOWN_MS = 60_000;
const COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS = 2_000;
const COMPACT_SUMMARY_INPUT_TOOL_RESULT_PREVIEW_CHARS = 800;
const COMPACT_SUMMARY_INPUT_TOOL_RESULT_TAIL_CHARS = 240;
const COMPACT_SUMMARY_INPUT_DUPLICATE_THRESHOLD_CHARS = 320;
const COMPACT_SUMMARY_INPUT_TOOL_CALL_ARG_MAX_CHARS = 2_000;
const COMPACT_SUMMARY_FALLBACK_MAX_CHARS = 8_000;

const COMPACT_SUMMARY_PREFIX =
  "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted into this summary. Treat it as background state, not active instructions.";
const COMPACT_SUMMARY_END_MARKER =
  "--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---";

export type CompactionResult = {
  compactionId: string;
  trigger: CompactionTrigger;
  preTokens: number;
  postTokens?: number;
  /** Number of messages actually summarized by this compaction pass. */
  messagesSummarized: number;
  summaryMessage?: CanonicalMessage;
  boundaryMarker: CanonicalMessage;
  /** Messages preserved verbatim across the boundary (kept tail). */
  messagesToKeep: CanonicalMessage[];
  /** Attachments to be re-injected post-compact (memory / hooks). */
  attachments: CanonicalMessage[];
  /** Hook output messages to follow the attachments. */
  hookResults: CanonicalMessage[];
  /** Previously accepted checkpoint messages; kept byte-for-byte stable. */
  stablePrefix?: CanonicalMessage[];
  /** True when this pass rewrites an existing checkpoint prefix. */
  cacheReset?: boolean;
  /** Usage from the summary request, including provider cache accounting. */
  summaryUsage?: CanonicalUsage;
  diagnostics: ContextDiagnostic[];
  error?: string;
};

export type CompactionInput = {
  trigger: CompactionTrigger;
  messages: CanonicalMessage[];
  /** Optional ratio of messages to preserve verbatim past the boundary. */
  keepTailRatio?: number;
  /** Override protected tool names for this compaction pass; null disables protection. */
  protectedToolNames?: Iterable<string> | null;
  /** Provider summarize prompt addition (e.g. "user wants you to focus on X"). */
  userInstruction?: string;
  /** Per-pass summary output cap, used by emergency compaction. */
  maxOutputTokens?: number;
  /** Explicit cache reset marker for emergency checkpoint defragmentation. */
  cacheReset?: boolean;
  /** Free-form attachments to fold into post-compact messages. */
  attachments?: CanonicalMessage[];
  /** Hook output messages to fold in after attachments (decision §3.1 #9 order). */
  hookResults?: CanonicalMessage[];
  signal?: AbortSignal;
  sessionId?: string;
  turnId?: string;
};

const DEFAULT_KEEP_TAIL_RATIO = 0.35;
const DEFAULT_MIN_TAIL_MESSAGES = 3;
const RELAXED_MIN_TAIL_MESSAGES = 1;

/**
 * Owned by `AgentLoop`, not by `ContextRuntime`. Performs the second model
 * call required to summarize a conversation, writes the summary message and
 * boundary marker, and assembles `buildPostCompactMessages` in legacy order
 * (decision §3.1 #9).
 */
export class CompactionEngine {
  private readonly tokenBudget: TokenBudgetManager;
  private readonly options: CompactionEngineOptions;
  private readonly protectedToolNames: ReadonlySet<string>;
  private summaryFailureCooldownUntil = 0;
  private summaryFailureError?: string;

  constructor(options: CompactionEngineOptions) {
    this.options = options;
    this.tokenBudget = options.tokenBudget ?? new TokenBudgetManager();
    this.protectedToolNames = protectedToolNameSet(options.protectedToolNames);
  }

  async run(input: CompactionInput): Promise<CompactionResult> {
    const compactionId = this.options.uuid?.() ?? randomUUID();
    const checkpoint = splitCheckpointPrefix(input.messages);
    const preTokens = this.estimateMessages(input.messages);
    const tailRatio = clamp(input.keepTailRatio ?? DEFAULT_KEEP_TAIL_RATIO, 0, 1);
    const tailTokenBudget = Math.max(1, Math.floor(preTokens * tailRatio));
    const protectedToolNames = input.protectedToolNames === null
      ? new Set<string>()
      : input.protectedToolNames ?? this.protectedToolNames;
    const minTailMessages = input.protectedToolNames === null
      ? RELAXED_MIN_TAIL_MESSAGES
      : DEFAULT_MIN_TAIL_MESSAGES;
    const compactPlan = planFullCompactionMessages(
      checkpoint.liveMessages,
      tailTokenBudget,
      protectedToolNames,
      minTailMessages,
      (turnMessages) => this.estimateMessages(turnMessages),
    );
    const messagesToSummarize = compactPlan.messagesToSummarize;
    const retainedTailExceededBudget = this.estimateMessages(compactPlan.messagesToKeep) > tailTokenBudget;
    const messagesToKeep = retainedTailExceededBudget
      ? projectOversizedRetainedToolResults(compactPlan.messagesToKeep, collectToolNamesByCallId(input.messages))
      : compactPlan.messagesToKeep;

    await this.options.lifecycle?.dispatch({
      event: "PreCompact",
      payload: {
        trigger: input.trigger,
        preTokens,
        messagesSummarized: messagesToSummarize.length,
      },
    });
    this.options.eventEmitter?.({
      type: "compact_started",
      sessionId: input.sessionId ?? "",
      turnId: input.turnId ?? "",
      compactionId,
      trigger: input.trigger,
      preTokens,
    });

    let summaryMessage: CanonicalMessage | undefined;
    let summaryError: string | undefined;
    let summaryUsage: CanonicalUsage | undefined;

    if (messagesToSummarize.length === 0) {
      // Nothing to summarize: still emit a boundary so the transcript captures
      // the intent, but no model call happens.
    } else {
      const summaryAnchors = input.protectedToolNames === null
        ? buildCompactSummaryAnchors(checkpoint.liveMessages, this.protectedToolNames)
        : undefined;
      // The summary sees the entire live segment, including the retained tail.
      // This makes a later post-summary snip semantically safe.
      const summaryInput = projectMessagesForSummary([
        ...checkpoint.stablePrefix,
        ...checkpoint.liveMessages,
      ]);
      if (this.isSummaryFailureCooldownActive()) {
        summaryError = this.summaryFailureError ?? "context summary is in cooldown";
        summaryMessage = buildDeterministicFallbackSummary(messagesToSummarize, summaryError);
      } else {
        try {
          const result = await this.summarize(
            summaryInput,
            input.userInstruction,
            input.signal,
            summaryAnchors,
            input.maxOutputTokens,
          );
          summaryMessage = wrapSummaryMessage(result.message);
          summaryUsage = result.usage;
          this.summaryFailureCooldownUntil = 0;
          this.summaryFailureError = undefined;
        } catch (error) {
          summaryError = error instanceof Error ? error.message : String(error);
          this.summaryFailureCooldownUntil = Date.now() + COMPACT_SUMMARY_FAILURE_COOLDOWN_MS;
          this.summaryFailureError = summaryError;
          summaryMessage = buildDeterministicFallbackSummary(messagesToSummarize, summaryError);
        }
      }
    }

    const boundaryMarker = this.createBoundaryMarker({
      trigger: input.trigger,
      preTokens,
      messagesSummarized: messagesToSummarize.length,
      summarySucceeded: summaryError === undefined,
    });

    const diagnostics: ContextDiagnostic[] = summaryError
      ? [
          {
            code: "compact_summary_failed",
            severity: "warning" as const,
            message: summaryError,
          },
          {
            code: "compact_summary_fallback_used",
            severity: "warning" as const,
            message: "A deterministic fallback summary was used because the LLM summary call failed or is cooling down.",
          },
        ]
      : summaryMessage
        ? validateSummaryMarkdownStructure(summaryMessage)
        : [];
    if (retainedTailExceededBudget && messagesToKeep !== compactPlan.messagesToKeep) {
      diagnostics.push({
        code: "compact_retained_tool_output_truncated",
        severity: "warning",
        message: "Oversized retained tool output was replaced with a bounded preview so the compacted context can fit the tail budget.",
      });
    }

    const result: CompactionResult = {
      compactionId,
      trigger: input.trigger,
      preTokens,
      messagesSummarized: messagesToSummarize.length,
      summaryMessage,
      boundaryMarker,
      messagesToKeep,
      stablePrefix: checkpoint.stablePrefix,
      cacheReset: input.cacheReset ?? (checkpoint.stablePrefix.length > 0 && input.trigger !== "auto"),
      summaryUsage,
      attachments: input.attachments ?? [],
      hookResults: input.hookResults ?? [],
      diagnostics,
      error: summaryError,
    };

    if (summaryMessage) {
      result.postTokens = this.estimateMessages(buildPostCompactMessages(result));
    }

    await this.options.lifecycle?.dispatch({
      event: "PostCompact",
      payload: {
        trigger: input.trigger,
        status: summaryError ? "fallback" : "success",
        error: summaryError,
        preTokens,
        postTokens: result.postTokens,
        summaryUsage,
        cacheReset: result.cacheReset === true,
      },
    });
    this.options.eventEmitter?.({
      type: "compact_completed",
      sessionId: input.sessionId ?? "",
      turnId: input.turnId ?? "",
      compactionId,
      trigger: input.trigger,
      status: summaryError ? "fallback" : "success",
      preTokens,
      postTokens: result.postTokens,
      messagesSummarized: messagesToSummarize.length,
      cacheReset: result.cacheReset === true,
      cacheReadTokens: summaryUsage?.cacheReadTokens,
      cacheWriteTokens: summaryUsage?.cacheWriteTokens,
    });

    return result;
  }

  private estimateMessages(messages: CanonicalMessage[]): number {
    return this.options.tokenAccounting?.estimateMessages(messages)
      ?? this.tokenBudget.estimateMessagesTokens(messages);
  }

  private async summarize(
    messages: CanonicalMessage[],
    userInstruction: string | undefined,
    signal: AbortSignal | undefined,
    summaryAnchors: string | undefined,
    maxOutputTokens: number | undefined,
  ): Promise<{ message: CanonicalMessage; usage?: CanonicalUsage }> {
    const trailingPrompt: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: buildMarkdownSummaryUserPrompt(userInstruction, summaryAnchors),
        },
      ],
      metadata: {
        synthetic: true,
        purpose: "context-summary-control",
      },
    };
    const request: CanonicalModelRequest = {
      provider: this.options.provider,
      model: this.options.model_,
      messages: [...messages, trailingPrompt],
      systemPrompt: this.options.systemPrompt
        ? buildMarkdownSummarySystemPrompt(this.options.systemPrompt)
        : COMPACT_SUMMARY_SYSTEM_PROMPT_DEFAULT,
      maxOutputTokens: maxOutputTokens ?? this.options.maxOutputTokens ?? COMPACT_MAX_OUTPUT_TOKENS,
      stream: true,
      thinking: { enabled: false },
      cacheBreakpoints: [],
    };

    let text = "";
    let usage: CanonicalUsage | undefined;
    let finishReason: CanonicalFinishReason | undefined;
    for await (const event of this.options.model.stream(request, signal)) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "usage":
          usage = event.usage;
          break;
        case "message_end":
          finishReason = event.finishReason;
          break;
        case "error":
          throw new Error(event.error.message);
        default:
          break;
      }
    }

    if (text.trim().length === 0) {
      throw new Error("Summary model returned empty content");
    }
    if (finishReason === "length") {
      throw new Error("Summary model output was truncated at the token limit");
    }
    if (finishReason === "content_filter") {
      throw new Error("Summary model output was stopped by content filtering");
    }

    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: text.trim() }],
      },
      usage,
    };
  }

  private isSummaryFailureCooldownActive(): boolean {
    return this.summaryFailureCooldownUntil > Date.now();
  }

  private createBoundaryMarker(opts: {
    trigger: CompactionTrigger;
    preTokens: number;
    messagesSummarized: number;
    summarySucceeded: boolean;
  }): CanonicalMessage {
    const status = opts.summarySucceeded ? "ok" : "summary_failed";
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `<compact-boundary trigger="${opts.trigger}" preTokens="${opts.preTokens}" messagesSummarized="${opts.messagesSummarized}" status="${status}" />`,
        },
      ],
    };
  }
}

/**
 * Decision §3.1 #9 — exact legacy order:
 *   boundaryMarker → summary → keep → attachments → hookResults
 */
export function buildPostCompactMessages(result: CompactionResult): CanonicalMessage[] {
  const out: CanonicalMessage[] = [...(result.stablePrefix ?? []), result.boundaryMarker];
  if (result.summaryMessage) {
    out.push(result.summaryMessage);
  }
  out.push(...result.messagesToKeep);
  out.push(...result.attachments);
  out.push(...result.hookResults);
  return ensureTrailingUserMessage(out);
}

function splitCheckpointPrefix(messages: CanonicalMessage[]): {
  stablePrefix: CanonicalMessage[];
  liveMessages: CanonicalMessage[];
} {
  let index = 0;
  // A compact checkpoint is emitted as a boundary marker followed by the
  // wrapped assistant summary. Keep every accepted pair immutable.
  while (index + 1 < messages.length
    && isCompactBoundaryMessage(messages[index]!)
    && isWrappedSummaryMessage(messages[index + 1]!)) {
    index += 2;
  }
  return {
    stablePrefix: messages.slice(0, index),
    liveMessages: messages.slice(index),
  };
}

function isCompactBoundaryMessage(message: CanonicalMessage): boolean {
  return message.role === "user"
    && message.content.some((block) => block.type === "text" && block.text.startsWith("<compact-boundary"));
}

function isWrappedSummaryMessage(message: CanonicalMessage): boolean {
  return message.role === "assistant"
    && message.content.some((block) => block.type === "text" && block.text.startsWith(COMPACT_SUMMARY_PREFIX));
}

function planFullCompactionMessages(
  messages: CanonicalMessage[],
  tailTokenBudget: number,
  protectedToolNames: Iterable<string>,
  minTailMessages: number,
  estimateTurnTokens: (turnMessages: CanonicalMessage[]) => number,
): { messagesToSummarize: CanonicalMessage[]; messagesToKeep: CanonicalMessage[] } {
  const turns = splitMessagesIntoCompactionGroups(messages);
  const tailStartTurn = moveTailBoundaryBeforeProtectedRequest(
    turns,
    findTailStartTurn(turns, tailTokenBudget, minTailMessages, estimateTurnTokens),
    protectedToolNames,
  );
  const prefixTurns = turns.slice(0, tailStartTurn);
  const prefix = prefixTurns.flatMap((turn) => turn.messages);
  const tail = turns.slice(tailStartTurn).flatMap((turn) => turn.messages);
  const protectedIndexes = collectProtectedGroupIndexes(prefixTurns, { protectedToolNames });
  const protectedMessages: CanonicalMessage[] = [];
  const messagesToSummarize: CanonicalMessage[] = [];

  for (const turn of prefixTurns) {
    if (protectedIndexes.has(turn.index)) {
      protectedMessages.push(...turn.messages);
    } else {
      messagesToSummarize.push(...turn.messages);
    }
  }

  // Tool pair integrity: the summarized portion will be replaced by a summary
  // message, so any tool_result in the preserved portion whose tool_call was
  // summarized away (and vice versa) must be stripped.
  const preserved = [...protectedMessages, ...tail];
  const preservedToolResultIds = collectToolResultIds(preserved);
  const withoutDanglingCalls = stripUnpairedToolCalls(preserved, preservedToolResultIds);
  const pairedToolCallIds = collectToolCallIds(withoutDanglingCalls);
  const messagesToKeep = stripUnpairedToolResults(withoutDanglingCalls, pairedToolCallIds);

  return { messagesToSummarize, messagesToKeep };
}

function splitMessagesIntoCompactionGroups(messages: CanonicalMessage[]): Array<{ index: number; messages: CanonicalMessage[] }> {
  const groups: Array<{ index: number; messages: CanonicalMessage[] }> = [];
  let current: CanonicalMessage[] = [];
  const flush = () => {
    if (current.length === 0) return;
    groups.push({ index: groups.length, messages: current });
    current = [];
  };

  for (const message of messages) {
    if (message.role === "user" && !isToolResultOnlyMessage(message)) {
      flush();
      groups.push({ index: groups.length, messages: [message] });
      continue;
    }
    if (message.role === "assistant") {
      flush();
      current = [message];
      continue;
    }
    current.push(message);
  }
  flush();
  return groups;
}

function collectProtectedGroupIndexes(
  groups: Array<{ index: number; messages: CanonicalMessage[] }>,
  options: { protectedToolNames?: Iterable<string> } = {},
): Set<number> {
  const toolNamesByCallId = collectToolNamesByCallId(groups.flatMap((group) => group.messages));
  const protectedIndexes = new Set<number>();
  for (const group of groups) {
    if (hasProtectedContextMessage(group.messages, toolNamesByCallId, options)) {
      protectedIndexes.add(group.index);
      // Compaction groups deliberately split tool cycles inside one user task
      // so older cycles can still be summarized. When a protected cycle is
      // retained, however, its initiating request must stay with it. Without
      // this, the generated summary can be immediately followed by an
      // assistant tool call, which violates providers' role ordering rules.
      const previous = groups[group.index - 1];
      if (previous && isStandaloneUserRequestGroup(previous.messages)) {
        protectedIndexes.add(previous.index);
      }
    }
  }
  return protectedIndexes;
}

function moveTailBoundaryBeforeProtectedRequest(
  groups: Array<{ index: number; messages: CanonicalMessage[] }>,
  tailStartTurn: number,
  protectedToolNames: Iterable<string>,
): number {
  if (tailStartTurn <= 0 || tailStartTurn >= groups.length) {
    return tailStartTurn;
  }
  const toolNamesByCallId = collectToolNamesByCallId(groups.flatMap((group) => group.messages));

  // A protected turn in the prefix must stay in chronological order with the
  // work that follows it. Move the boundary before the earliest protected
  // turn, keeping its initiating user request when present. Otherwise the old
  // implementation summarized later work and then appended the protected turn
  // after that summary, reversing the causal order seen by the model.
  for (let index = 0; index < tailStartTurn; index += 1) {
    if (!hasProtectedContextMessage(groups[index]!.messages, toolNamesByCallId, { protectedToolNames })) {
      continue;
    }
    const precedingGroup = groups[index - 1];
    if (precedingGroup && isStandaloneUserRequestGroup(precedingGroup.messages)) {
      return precedingGroup.index;
    }
    return index;
  }

  const firstTailGroup = groups[tailStartTurn]!;
  const precedingGroup = groups[tailStartTurn - 1]!;
  if (
    hasProtectedContextMessage(firstTailGroup.messages, toolNamesByCallId, { protectedToolNames })
    && isStandaloneUserRequestGroup(precedingGroup.messages)
  ) {
    return precedingGroup.index;
  }
  return tailStartTurn;
}

function hasProtectedContextMessage(
  messages: CanonicalMessage[],
  toolNamesByCallId: ReadonlyMap<string, string>,
  options: { protectedToolNames?: Iterable<string> } = {},
): boolean {
  return messages.some((message) =>
    isProtectedContextMessage(message, {
      ...options,
      toolNamesByCallId,
    })
  );
}

function isStandaloneUserRequestGroup(messages: CanonicalMessage[]): boolean {
  return messages.length === 1
    && messages[0]!.role === "user"
    && !isToolResultOnlyMessage(messages[0]!);
}

function isToolResultOnlyMessage(message: CanonicalMessage): boolean {
  return message.content.length > 0 && message.content.every((block) =>
    block.type === "tool_result" || block.type === "tool_result_reference"
  );
}

function findTailStartTurn(
  turns: Array<{ index: number; messages: CanonicalMessage[] }>,
  tailTokenBudget: number,
  minTailMessagesInput: number,
  estimateTurnTokens: (turnMessages: CanonicalMessage[]) => number,
): number {
  if (turns.length === 0) {
    return 0;
  }

  const softBudget = Math.max(1, Math.floor(tailTokenBudget * 1.5));
  const requestedFloor = Math.max(1, Math.floor(minTailMessagesInput));
  const totalMessages = turns.reduce((sum, turn) => sum + turn.messages.length, 0);
  const minTailMessages = requestedFloor <= 1
    ? 1
    : Math.min(8, Math.max(requestedFloor, Math.floor(totalMessages * 0.1) || requestedFloor));

  let accumulated = 0;
  let keptMessages = 0;
  let cutIndex = turns.length;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const turnTokens = estimateTurnTokens(turn.messages);
    const wouldExceed = accumulated + turnTokens > softBudget;
    if (wouldExceed && keptMessages >= minTailMessages) {
      break;
    }
    accumulated += turnTokens;
    keptMessages += turn.messages.length;
    cutIndex = index;
  }

  if (cutIndex <= 0 && accumulated > 0 && accumulated <= softBudget) {
    let rawAccumulated = 0;
    let rawKeptMessages = 0;
    cutIndex = turns.length;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      const turnTokens = estimateTurnTokens(turn.messages);
      if (rawAccumulated + turnTokens > tailTokenBudget && rawKeptMessages >= minTailMessages) {
        break;
      }
      rawAccumulated += turnTokens;
      rawKeptMessages += turn.messages.length;
      cutIndex = index;
    }
  }

  if (cutIndex <= 0 && turns.length > 1) {
    let messageCount = 0;
    cutIndex = turns.length;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      messageCount += turns[index]!.messages.length;
      cutIndex = index;
      if (messageCount >= minTailMessages) {
        break;
      }
    }
  }

  return Math.max(0, cutIndex);
}

/**
 * Last-resort head truncation: keep the trailing `keepRatio` portion (legacy
 * `truncateHeadForPTLRetry` 25% slice). Single-shot per turn (decision §3.1 #8).
 */
export function truncateHead(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  const ratio = clamp(keepRatio, 0.05, 1);
  const keep = Math.max(1, Math.floor(messages.length * ratio));
  return messages.slice(-keep);
}

/** Emergency projection that keeps accepted checkpoint messages before the
 * newest live suffix. Used only after summary and snip could not fit. */
export function truncateHeadPreservingCheckpoint(
  messages: CanonicalMessage[],
  keepRatio: number,
): CanonicalMessage[] {
  const checkpoint = splitCheckpointPrefix(messages);
  if (checkpoint.stablePrefix.length === 0) {
    return ensureTrailingUserMessage(truncateTailPreservingToolPairs(messages, keepRatio));
  }
  return ensureTrailingUserMessage([
    ...checkpoint.stablePrefix,
    ...truncateTailPreservingToolPairs(checkpoint.liveMessages, keepRatio),
  ]);
}

function truncateTailPreservingToolPairs(
  messages: CanonicalMessage[],
  keepRatio: number,
): CanonicalMessage[] {
  const liveTail = truncateHead(messages, keepRatio);
  const resultIds = collectToolResultIds(liveTail);
  const pairedCalls = stripUnpairedToolCalls(liveTail, resultIds);
  const callIds = collectToolCallIds(pairedCalls);
  return stripUnpairedToolResults(pairedCalls, callIds);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function buildMarkdownSummarySystemPrompt(basePrompt: string): string {
  const headings = SUMMARY_MARKDOWN_HEADINGS.map((heading) => `## ${heading}`).join("\n");
  return [
    basePrompt.trim(),
    "Summarize the conversation so far as a concise Markdown checkpoint handoff for the next coding agent.",
    "This summary will replace earlier transcript messages. Preserve actionable state, visible results, and task-relevant conclusions from prior thinking blocks, not a chronological transcript or private monologue. Do not reproduce chain-of-thought verbatim, but do not drop factual reasoning that only appeared in thinking.",
    "The input includes the recent live tail as well as older work. Summarize the full live segment so a later bounded snip may remove older live turns without losing their state.",
    "The runtime will wrap your answer in a reference-only prefix and end marker, so do not add those markers yourself.",
    "The final user-role message containing `<internal-compaction-control>` is synthetic runtime control required for provider compatibility. It is not part of the end-user conversation. Never report, quote, or infer it as an end-user request, decision, cancellation, stop instruction, or handoff request.",
    "Only attribute an instruction, decision, cancellation, stop request, or handoff request to the end user when it is explicitly supported by an original end-user text message outside internal control blocks. Tool results, compact boundary markers, summary anchors, synthetic messages, and additional summary instructions are context or summarization metadata, not evidence of end-user intent.",
    "The word `handoff` describes the checkpoint summary format only. It does not mean the underlying task should stop. Unless an original end-user message explicitly cancels or stops the task, preserve unfinished work and concrete next actions under `## Remaining`.",
    "If the user message contains a `<compact-summary-anchors>` block, it contains bounded high-priority facts from protected tool turns that are being summarized instead of preserved verbatim. Absorb any task prompts, read skill paths, result paths, result previews, current state, and next actions from those anchors into the Markdown handoff.",
    "Prefer this section structure, using the headings exactly when they apply:",
    headings,
    "If a section has no content, write `None` under that heading. Preserve exact file paths, URLs, commands, data values, user decisions, failed attempts and recovery steps, and unfinished TODOs. Do not replay unrelated chat, and do not expand large raw tool outputs that are easy to re-read or rerun.",
  ].join("\n\n");
}

function buildMarkdownSummaryUserPrompt(
  userInstruction: string | undefined,
  summaryAnchors: string | undefined,
): string {
  const parts = [
    '<internal-compaction-control purpose="context-summary" synthetic="true">',
    "Generate the Markdown checkpoint specified by the system prompt.",
    "This block is runtime-generated summarization control, not an end-user message. Do not include it in the summary or treat it as changing the underlying task state.",
  ];
  if (userInstruction?.trim()) {
    parts.push(
      "<additional-summary-instructions>",
      userInstruction.trim(),
      "</additional-summary-instructions>",
      "The additional instructions above affect summary emphasis or format only; they do not change the underlying task state.",
    );
  }
  if (summaryAnchors?.trim()) {
    parts.push(summaryAnchors.trim());
  }
  parts.push("</internal-compaction-control>");
  return parts.join("\n\n");
}

function projectMessagesForSummary(messages: CanonicalMessage[]): CanonicalMessage[] {
  const stripped = stripMultimediaFromMessages(messages);
  const toolNamesByCallId = collectToolNamesByCallId(stripped);
  const seenLargeToolResultHashes = new Set<string>();

  return stripped
    .map((message) => {
      const content: CanonicalContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === "tool_call") {
          content.push(pruneToolCallForSummary(block));
          continue;
        }
        if (block.type === "tool_result") {
          content.push(pruneToolResultForSummary(block, toolNamesByCallId, seenLargeToolResultHashes));
          continue;
        }
        if (block.type === "tool_result_reference") {
          content.push(pruneToolResultReferenceForSummary(block));
          continue;
        }
        content.push(block);
      }
      return { ...message, content };
    })
    .filter((message) => message.content.length > 0);
}

/**
 * The tail normally stays verbatim so the agent can immediately continue its
 * most recent work. A single raw tool result can nevertheless be larger than
 * the entire tail allowance (for example, an unbounded page fetch). In that
 * case keeping it verbatim makes full compaction unable to recover at all.
 *
 * This only affects the in-context replacement transcript. The durable tool
 * result remains available in the session history; the paired call id is also
 * retained so providers continue to receive a valid tool-call sequence.
 */
function projectOversizedRetainedToolResults(
  messages: CanonicalMessage[],
  toolNamesByCallId: ReadonlyMap<string, string>,
): CanonicalMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }
      const flattened = flattenToolResultContentText(block.content).trim();
      if (flattened.length <= COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS) {
        return block;
      }
      changed = true;
      const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
      return {
        type: "tool_result" as const,
        toolCallId: block.toolCallId,
        ...(block.isError === true ? { isError: true } : {}),
        content: [
          {
            type: "text" as const,
            text: `${summarizeToolResultForSummary(toolName, block.toolCallId, flattened, block.isError === true)}\n[Full output remains in the durable session transcript.]`,
          },
        ],
      };
    });
    return changed ? { ...message, content } : message;
  });
  return changed ? projected : messages;
}

function pruneToolCallForSummary(block: CanonicalToolCallBlock): CanonicalToolCallBlock {
  return {
    type: "tool_call",
    id: block.id,
    name: block.name,
    input: pruneSummaryInputValue(block.input),
  };
}

function pruneToolResultForSummary(
  block: CanonicalToolResultBlock,
  toolNamesByCallId: ReadonlyMap<string, string>,
  seenLargeToolResultHashes: Set<string>,
): CanonicalToolResultBlock {
  const flattened = flattenToolResultContentText(block.content).trim();
  const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
  const isLarge = flattened.length > COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS;
  const eligibleForDedup = flattened.length > COMPACT_SUMMARY_INPUT_DUPLICATE_THRESHOLD_CHARS;
  const hash = eligibleForDedup ? hashSummaryText(flattened) : undefined;

  if (isLarge && hash && seenLargeToolResultHashes.has(hash)) {
    return {
      type: "tool_result",
      toolCallId: block.toolCallId,
      isError: block.isError,
      content: [
        {
          type: "text",
          text: `[Duplicate tool output omitted for ${toolName} call ${block.toolCallId}. A newer call produced the same large output.]`,
        },
      ],
    };
  }
  if (hash) {
    seenLargeToolResultHashes.add(hash);
  }

  if (!isLarge) {
    return {
      type: "tool_result",
      toolCallId: block.toolCallId,
      isError: block.isError,
      content: block.content,
    };
  }

  return {
    type: "tool_result",
    toolCallId: block.toolCallId,
    isError: block.isError,
    content: [
      {
        type: "text",
        text: summarizeToolResultForSummary(toolName, block.toolCallId, flattened, block.isError === true),
      },
    ],
  };
}

function pruneToolResultReferenceForSummary(
  block: Extract<CanonicalContentBlock, { type: "tool_result_reference" }>,
): Extract<CanonicalContentBlock, { type: "tool_result_reference" }> {
  return {
    ...block,
    path: truncateForAnchor(block.path, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS),
    ...(block.readFilePath
      ? { readFilePath: truncateForAnchor(block.readFilePath, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS) }
      : {}),
    preview: truncateForAnchor(block.preview, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS),
    ...(block.reason ? { reason: truncateForAnchor(block.reason, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS) } : {}),
  };
}

function pruneSummaryInputValue(value: unknown): unknown {
  return pruneSummaryInputValueInner(value, 0, new WeakSet<object>());
}

function pruneSummaryInputValueInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return truncateForSummaryInput(value, COMPACT_SUMMARY_INPUT_TOOL_CALL_ARG_MAX_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= 4) {
    return "[Truncated]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.slice(0, 20).map((item) => pruneSummaryInputValueInner(item, depth + 1, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(value)) {
      if (count >= 20) {
        break;
      }
      out[key] = pruneSummaryInputValueInner(child, depth + 1, seen);
      count += 1;
    }
    return out;
  }
  return truncateForSummaryInput(String(value), COMPACT_SUMMARY_INPUT_TOOL_CALL_ARG_MAX_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function summarizeToolResultForSummary(
  toolName: string,
  toolCallId: string,
  flattened: string,
  isError: boolean,
): string {
  const normalized = flattened.replace(/\s+/g, " ").trim();
  const preview = summarizeTextPreview(normalized);
  const kind = isError ? "error" : "output";
  return `[${toolName}] ${kind} for call ${toolCallId}: ${preview}`;
}

function summarizeTextPreview(text: string): string {
  if (text.length <= COMPACT_SUMMARY_INPUT_TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  const head = text.slice(0, COMPACT_SUMMARY_INPUT_TOOL_RESULT_PREVIEW_CHARS).trimEnd();
  const tail = text.slice(-COMPACT_SUMMARY_INPUT_TOOL_RESULT_TAIL_CHARS).trimStart();
  return `${head}\n...[truncated]...\n${tail}`;
}

function truncateForSummaryInput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(0, maxChars - 16);
  return `${value.slice(0, head).trimEnd()}...[truncated]`;
}

function hashSummaryText(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function wrapSummaryMessage(message: CanonicalMessage): CanonicalMessage {
  const text = normalizeSummaryEnvelope(message);
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function normalizeSummaryEnvelope(message: CanonicalMessage): string {
  const body = redactSensitiveText(
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim(),
  );
  const stripped = stripSummaryEnvelope(body);
  return `${COMPACT_SUMMARY_PREFIX}\n\n${stripped || "(empty summary)"}\n\n${COMPACT_SUMMARY_END_MARKER}`;
}

function stripSummaryEnvelope(text: string): string {
  let out = text.trim();
  if (out.startsWith(COMPACT_SUMMARY_PREFIX)) {
    out = out.slice(COMPACT_SUMMARY_PREFIX.length).trimStart();
  }
  if (out.startsWith(COMPACT_SUMMARY_END_MARKER)) {
    out = out.slice(COMPACT_SUMMARY_END_MARKER.length).trimStart();
  }
  if (out.endsWith(COMPACT_SUMMARY_END_MARKER)) {
    out = out.slice(0, -COMPACT_SUMMARY_END_MARKER.length).trimEnd();
  }
  return out;
}

function buildDeterministicFallbackSummary(messages: CanonicalMessage[], reason: string | undefined): CanonicalMessage {
  const facts = collectFallbackSummaryFacts(messages);
  let body = [
    "## Objective",
    facts.objective || "None",
    "",
    "## Current State",
    facts.currentState || "None",
    "",
    "## Completed",
    formatBulletList(facts.completed, 8),
    "",
    "## Remaining",
    formatBulletList(facts.remaining, 8),
    "",
    "## Decisions",
    formatBulletList(facts.decisions, 8),
    "",
    "## Files And Artifacts",
    formatBulletList(facts.files, 12),
    "",
    "## Tool Findings",
    formatBulletList(facts.toolFindings, 8),
    "",
    "## Thinking",
    formatBulletList(facts.thinking, 8),
    "",
    "## Errors And Recovery",
    formatBulletList(
      [
        ...(reason ? [reason] : []),
        ...facts.errors,
      ],
      8,
    ),
    "",
    "## Open Questions",
    formatBulletList(facts.openQuestions, 8),
  ].join("\n");

  if (body.length > COMPACT_SUMMARY_FALLBACK_MAX_CHARS) {
    body = `${body.slice(0, COMPACT_SUMMARY_FALLBACK_MAX_CHARS - 40).trimEnd()}\n...[fallback summary truncated]`;
  }

  return wrapSummaryMessage({
    role: "assistant",
    content: [{ type: "text", text: body }],
  });
}

type FallbackSummaryFacts = {
  objective: string;
  currentState: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  files: string[];
  toolFindings: string[];
  thinking: string[];
  errors: string[];
  openQuestions: string[];
};

function collectFallbackSummaryFacts(messages: CanonicalMessage[]): FallbackSummaryFacts {
  const userTexts: string[] = [];
  const completed: string[] = [];
  const remaining: string[] = [];
  const decisions: string[] = [];
  const files: string[] = [];
  const toolFindings: string[] = [];
  const thinking: string[] = [];
  const errors: string[] = [];
  const openQuestions: string[] = [];
  const toolNamesByCallId = collectToolNamesByCallId(messages);
  const currentStateBits: string[] = [];

  for (const message of messages) {
    const visibleText = visibleTextFromMessage(message);
    if (message.role === "user" && visibleText) {
      userTexts.push(visibleText);
      if (visibleText.includes("?")) {
        openQuestions.push(shortenFallbackText(visibleText, 220));
      }
      currentStateBits.push(shortenFallbackText(visibleText, 220));
    }
    if (message.role === "assistant") {
      const calls = message.content.filter((block) => block.type === "tool_call") as CanonicalToolCallBlock[];
      if (calls.length > 0) {
        completed.push(`Called tool(s): ${calls.map((call) => call.name).join(", ")}`);
        for (const call of calls) {
          collectFallbackPathsFromValue(call.input, files);
          if (call.name === "Task" || call.name === "read_skill") {
            const callText = buildToolCallSummaryText(call);
            toolFindings.push(callText);
          }
        }
      }
      if (visibleText) {
        completed.push(shortenFallbackText(visibleText, 220));
      }
    }
    for (const block of message.content) {
      if (block.type === "thinking") {
        thinking.push(shortenFallbackText(block.reasoningContent ?? block.text, 260));
        continue;
      }
      if (block.type === "tool_result") {
        const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
        const text = flattenToolResultContentText(block.content);
        const summary = summarizeFallbackToolResult(toolName, block.toolCallId, text, block.isError === true);
        toolFindings.push(summary);
        if (block.isError || /(?:error|failed|exception|traceback|timeout|fatal)/i.test(text)) {
          errors.push(shortenFallbackText(summary, 280));
        }
        collectFallbackPathsFromText(text, files);
        continue;
      }
      if (block.type === "tool_result_reference") {
        files.push(shortenFallbackText(block.readFilePath ?? block.path, 280));
        toolFindings.push(
          `Referenced ${shortenFallbackText(block.readFilePath ?? block.path, 180)} (${block.originalBytes} bytes)`,
        );
        if (block.preview) {
          toolFindings.push(shortenFallbackText(block.preview, 220));
        }
        continue;
      }
      if (block.type === "text") {
        collectFallbackPathsFromText(block.text, files);
      }
    }
  }

  if (userTexts.length === 0) {
    currentStateBits.push("No user messages were recoverable from the compacted window.");
  }
  remaining.push(
    userTexts.length > 0
      ? `Continue from the latest user request: ${shortenFallbackText(userTexts[userTexts.length - 1]!, 260)}`
      : "Continue from the preserved tail and verify current repository state before changing anything.",
  );
  if (userTexts.length > 1) {
    decisions.push(`Earlier user asks were: ${shortenFallbackText(userTexts.slice(0, -1).join(" | "), 260)}`);
  }

  return {
    objective: userTexts.length > 0 ? shortenFallbackText(userTexts[0]!, 280) : "Unknown from deterministic fallback.",
    currentState: currentStateBits.length > 0
      ? shortenFallbackText(currentStateBits.join(" / "), 320)
      : "Unknown from deterministic fallback.",
    completed: uniqueFallbackEntries(completed),
    remaining: uniqueFallbackEntries(remaining),
    decisions: uniqueFallbackEntries(decisions),
    files: uniqueFallbackEntries(files),
    toolFindings: uniqueFallbackEntries(toolFindings),
    thinking: uniqueFallbackEntries(thinking),
    errors: uniqueFallbackEntries(errors),
    openQuestions: uniqueFallbackEntries(openQuestions),
  };
}

function visibleTextFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function collectFallbackPathsFromValue(value: unknown, files: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    collectFallbackPathsFromText(value, files);
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFallbackPathsFromValue(item, files);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && /(?:path|file|read|cwd|dir|url|uri|location)/i.test(key)) {
      files.push(shortenFallbackText(entry, 280));
    }
    collectFallbackPathsFromValue(entry, files);
  }
}

function collectFallbackPathsFromText(text: string, files: string[]): void {
  const matches = text.match(/(?:\/|~\/?|[A-Za-z]:\\)[^\s`'"")\]}<>]+/g) ?? [];
  for (const match of matches) {
    files.push(shortenFallbackText(match.replace(/[.,:;]+$/g, ""), 280));
  }
}

function summarizeFallbackToolResult(toolName: string, toolCallId: string, text: string, isError: boolean): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const preview = shortenFallbackText(normalized, 260);
  return `[${toolName}] ${isError ? "error" : "result"} for ${toolCallId}: ${preview || "None"}`;
}

function buildToolCallSummaryText(call: CanonicalToolCallBlock): string {
  const input = summarizeFallbackInput(call.input);
  return `[${call.name}] call ${call.id}${input ? ` ${input}` : ""}`;
}

function summarizeFallbackInput(value: unknown): string {
  const rendered = JSON.stringify(value, circularJsonReplacer());
  if (!rendered) {
    return "";
  }
  return shortenFallbackText(rendered, 220);
}

function shortenFallbackText(text: string, maxChars: number): string {
  const normalized = redactSensitiveText(text.replace(/\s+/g, " ").trim());
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.max(0, maxChars - 16);
  return `${normalized.slice(0, head).trimEnd()}...[truncated]`;
}

function formatBulletList(items: string[], limit: number): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    lines.push(`- ${normalized}`);
    if (lines.length >= limit) {
      break;
    }
  }
  return lines.length > 0 ? lines.join("\n") : "None";
}

function uniqueFallbackEntries(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]")
    .replace(/\b(?:api[_ -]?key|secret|password|token)\s*[:=]\s*[^ \t\n\r,;]+/gi, "[REDACTED]");
}

type CompactSummaryAnchor = {
  turn: number;
  toolName: string;
  toolCallId: string;
  userRequest?: string;
  input?: string;
  resultPreview?: string;
  resultIsError?: boolean;
  resultReference?: {
    path: string;
    readFilePath?: string;
    originalBytes: number;
    hasMore: boolean;
    mimeType?: string;
    reason?: string;
  };
};

function buildCompactSummaryAnchors(
  messages: CanonicalMessage[],
  protectedToolNames: Iterable<string>,
): string | undefined {
  const protectedNames = protectedToolNameSet(protectedToolNames);
  if (protectedNames.size === 0) {
    return undefined;
  }

  const anchors: CompactSummaryAnchor[] = [];
  for (const turn of splitMessagesIntoTurns(messages)) {
    const userRequest = truncateForAnchor(visibleUserTextForTurn(turn.messages), COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS);
    const results = collectToolResultsForTurn(turn.messages);
    for (const message of turn.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "tool_call" || !protectedNames.has(block.name)) {
          continue;
        }
        const result = results.get(block.id);
        anchors.push({
          turn: turn.index,
          toolName: block.name,
          toolCallId: block.id,
          ...(userRequest ? { userRequest } : {}),
          ...(block.input !== undefined
            ? { input: stringifyForAnchor(block.input, COMPACT_SUMMARY_ANCHOR_MAX_INPUT_CHARS) }
            : {}),
          ...(result?.preview ? { resultPreview: result.preview } : {}),
          ...(result?.isError !== undefined ? { resultIsError: result.isError } : {}),
          ...(result?.reference ? { resultReference: result.reference } : {}),
        });
      }
    }
  }

  if (anchors.length === 0) {
    return undefined;
  }

  return renderCompactSummaryAnchors(anchors);
}

function collectToolResultsForTurn(messages: CanonicalMessage[]): Map<string, {
  preview?: string;
  isError?: boolean;
  reference?: CompactSummaryAnchor["resultReference"];
}> {
  const results = new Map<string, {
    preview?: string;
    isError?: boolean;
    reference?: CompactSummaryAnchor["resultReference"];
  }>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") {
        results.set(block.toolCallId, {
          preview: truncateForAnchor(flattenToolResultContentText(block.content), COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS),
          ...(block.isError !== undefined ? { isError: block.isError } : {}),
        });
      }
      if (block.type === "tool_result_reference") {
        results.set(block.toolCallId, {
          preview: truncateForAnchor(block.preview, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS),
          ...(block.isError !== undefined ? { isError: block.isError } : {}),
          reference: compactReferenceForAnchor(block),
        });
      }
    }
  }
  return results;
}

function compactReferenceForAnchor(block: CanonicalToolResultReferenceBlock): CompactSummaryAnchor["resultReference"] {
  return {
    path: truncateForAnchor(block.path, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS),
    ...(block.readFilePath
      ? { readFilePath: truncateForAnchor(block.readFilePath, COMPACT_SUMMARY_ANCHOR_MAX_PATH_CHARS) }
      : {}),
    originalBytes: block.originalBytes,
    hasMore: block.hasMore,
    ...(block.mimeType ? { mimeType: block.mimeType } : {}),
    ...(block.reason ? { reason: truncateForAnchor(block.reason, COMPACT_SUMMARY_ANCHOR_MAX_TEXT_CHARS) } : {}),
  };
}

function visibleUserTextForTurn(messages: CanonicalMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function renderCompactSummaryAnchors(anchors: CompactSummaryAnchor[]): string {
  const lines = [
    "<compact-summary-anchors>",
    "Each following line is a JSON object with visible facts from one protected tool call.",
  ];
  let charCount = lines.join("\n").length;
  let included = 0;
  const limitedAnchors = anchors.slice(0, COMPACT_SUMMARY_ANCHOR_MAX_ITEMS);

  for (const anchor of limitedAnchors) {
    const line = JSON.stringify(anchor);
    if (charCount + line.length + 1 > COMPACT_SUMMARY_ANCHOR_MAX_TOTAL_CHARS) {
      break;
    }
    lines.push(line);
    charCount += line.length + 1;
    included += 1;
  }

  const omitted = anchors.length - included;
  if (omitted > 0) {
    lines.push(JSON.stringify({ truncated: true, omittedProtectedToolCalls: omitted }));
  }
  lines.push("</compact-summary-anchors>");
  return lines.join("\n");
}

function stringifyForAnchor(value: unknown, maxChars: number): string {
  try {
    return truncateForAnchor(JSON.stringify(value, circularJsonReplacer()), maxChars);
  } catch {
    return truncateForAnchor(String(value), maxChars);
  }
}

function circularJsonReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  };
}

function truncateForAnchor(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

function validateSummaryMarkdownStructure(summaryMessage: CanonicalMessage): ContextDiagnostic[] {
  const text = summaryMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const missing = CORE_SUMMARY_MARKDOWN_HEADINGS.filter((heading) => !hasMarkdownHeading(text, heading));
  if (missing.length === 0) {
    return [];
  }
  return [{
    code: "compact_summary_structure_weak",
    severity: "warning",
    message: `Compact summary is missing recommended Markdown heading(s): ${missing.join(", ")}.`,
  }];
}

function hasMarkdownHeading(text: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(text);
}
