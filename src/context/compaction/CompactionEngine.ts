import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalUsage,
} from "../../model/index.js";
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

export type CompactionTrigger = "manual" | "auto" | "reactive";

export type CompactionEngineOptions = {
  /**
   * AgentLoop-supplied model runtime. CompactionEngine **does not** sit inside
   * `ContextRuntime`; the loop owns this dependency (decision §3.2).
   */
  model: { stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> };
  tokenBudget?: TokenBudgetManager;
  /** Optional lifecycle dispatcher (PreCompact / PostCompact). */
  lifecycle?: {
    dispatch(input: { event: "PreCompact" | "PostCompact"; payload: Record<string, unknown> }): void | Promise<void>;
  };
  /** Provider id forwarded to `stream()`. */
  provider: string;
  /** Model id forwarded to `stream()`. */
  model_: string;
  /** Optional summary system prompt override (default: legacy literal). */
  systemPrompt?: string;
  /** Max output tokens for the summary call (legacy default 20_000). */
  maxOutputTokens?: number;
  now?: () => Date;
  eventEmitter?: AgentEventEmitter;
};

export const COMPACT_SYSTEM_PROMPT_DEFAULT =
  "You are a conversation summarizer for a coding agent. Your summary will replace " +
  "the early conversation history, so it MUST preserve all information the agent " +
  "needs to continue working without repeating past steps.";
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

export type CompactionResult = {
  trigger: CompactionTrigger;
  preTokens: number;
  postTokens?: number;
  summaryMessage?: CanonicalMessage;
  boundaryMarker: CanonicalMessage;
  /** Messages preserved verbatim across the boundary (kept tail). */
  messagesToKeep: CanonicalMessage[];
  /** Attachments to be re-injected post-compact (memory / hooks). */
  attachments: CanonicalMessage[];
  /** Hook output messages to follow the attachments. */
  hookResults: CanonicalMessage[];
  diagnostics: ContextDiagnostic[];
  error?: string;
};

export type CompactionInput = {
  trigger: CompactionTrigger;
  messages: CanonicalMessage[];
  /** Optional ratio of messages to preserve verbatim past the boundary. */
  keepTailRatio?: number;
  /** Provider summarize prompt addition (e.g. "user wants you to focus on X"). */
  userInstruction?: string;
  /** Free-form attachments to fold into post-compact messages. */
  attachments?: CanonicalMessage[];
  /** Hook output messages to fold in after attachments (decision §3.1 #9 order). */
  hookResults?: CanonicalMessage[];
  signal?: AbortSignal;
  sessionId?: string;
  turnId?: string;
};

const DEFAULT_KEEP_TAIL_RATIO = 0.35;

/**
 * Owned by `AgentLoop`, not by `ContextRuntime`. Performs the second model
 * call required to summarize a conversation, writes the summary message and
 * boundary marker, and assembles `buildPostCompactMessages` in legacy order
 * (decision §3.1 #9).
 */
export class CompactionEngine {
  private readonly tokenBudget: TokenBudgetManager;
  private readonly options: CompactionEngineOptions;

  constructor(options: CompactionEngineOptions) {
    this.options = options;
    this.tokenBudget = options.tokenBudget ?? new TokenBudgetManager();
  }

  async run(input: CompactionInput): Promise<CompactionResult> {
    const preTokens = this.tokenBudget.estimateMessagesTokens(input.messages);
    const tailRatio = clamp(input.keepTailRatio ?? DEFAULT_KEEP_TAIL_RATIO, 0, 1);
    const keepCount = Math.max(1, Math.floor(input.messages.length * tailRatio));
    const messagesToSummarize = input.messages.slice(0, input.messages.length - keepCount);

    // Tool pair integrity: the summarize portion will be replaced by a
    // summary message, so any tool_result in the keep portion whose
    // tool_call is in the summarize portion (and vice-versa) becomes
    // dangling and must be stripped.
    const keepToolCallIds = collectToolCallIds(input.messages.slice(-keepCount));
    const keepToolResultIds = collectToolResultIds(input.messages.slice(-keepCount));
    const messagesToKeep = stripUnpairedToolResults(
      stripUnpairedToolCalls(input.messages.slice(-keepCount), keepToolResultIds),
      keepToolCallIds,
    );

    await this.options.lifecycle?.dispatch({
      event: "PreCompact",
      payload: {
        trigger: input.trigger,
        preTokens,
        messagesSummarized: messagesToSummarize.length,
      },
    });
    this.options.eventEmitter?.({ type: "compact_started", sessionId: input.sessionId ?? "", turnId: input.turnId ?? "", trigger: input.trigger, preTokens });

    let summaryMessage: CanonicalMessage | undefined;
    let summaryError: string | undefined;
    let summaryUsage: CanonicalUsage | undefined;

    if (messagesToSummarize.length === 0) {
      // Nothing to summarize: still emit a boundary so the transcript captures
      // the intent, but no model call happens.
    } else {
      try {
        const result = await this.summarize(messagesToSummarize, input.userInstruction, input.signal);
        summaryMessage = result.message;
        summaryUsage = result.usage;
      } catch (error) {
        summaryError = error instanceof Error ? error.message : String(error);
      }
    }

    const boundaryMarker = this.createBoundaryMarker({
      trigger: input.trigger,
      preTokens,
      messagesSummarized: messagesToSummarize.length,
      summarySucceeded: summaryError === undefined && summaryMessage !== undefined,
    });

    const result: CompactionResult = {
      trigger: input.trigger,
      preTokens,
      summaryMessage,
      boundaryMarker,
      messagesToKeep,
      attachments: input.attachments ?? [],
      hookResults: input.hookResults ?? [],
      diagnostics: summaryError
        ? [
            {
              code: "compact_summary_failed",
              severity: "error",
              message: summaryError,
            },
          ]
        : [],
      error: summaryError,
    };

    if (summaryMessage) {
      result.postTokens = this.tokenBudget.estimateMessagesTokens(buildPostCompactMessages(result));
    }

    await this.options.lifecycle?.dispatch({
      event: "PostCompact",
      payload: {
        trigger: input.trigger,
        status: summaryError ? "error" : "success",
        error: summaryError,
        preTokens,
        postTokens: result.postTokens,
        summaryUsage,
      },
    });
    this.options.eventEmitter?.({
      type: "compact_completed",
      sessionId: input.sessionId ?? "",
      turnId: input.turnId ?? "",
      status: summaryError ? "error" : "success",
      preTokens,
      postTokens: result.postTokens,
    });

    return result;
  }

  private async summarize(
    messages: CanonicalMessage[],
    userInstruction: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ message: CanonicalMessage; usage?: CanonicalUsage }> {
    const trailingPrompt: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: userInstruction
            ? `Summarize the conversation so far. ${userInstruction}`
            : "Summarize the conversation so far. You MUST include:\n" +
              "1. The original task/goal the user requested\n" +
              "2. A checklist of completed steps vs remaining steps\n" +
              "3. Key file paths, URLs, data values, and intermediate results discovered\n" +
              "4. Any errors encountered and how they were resolved\n" +
              "5. The current state and what the agent should do next\n" +
              "Be concise but preserve ALL actionable details. Do NOT omit search results, " +
              "computed values, or file contents that the agent will need.",
        },
      ],
    };
    const request: CanonicalModelRequest = {
      provider: this.options.provider,
      model: this.options.model_,
      messages: [...stripMultimediaFromMessages(messages), trailingPrompt],
      systemPrompt: this.options.systemPrompt ?? COMPACT_SYSTEM_PROMPT_DEFAULT,
      maxOutputTokens: this.options.maxOutputTokens ?? COMPACT_MAX_OUTPUT_TOKENS,
      stream: true,
      thinking: { enabled: false },
    };

    let text = "";
    let usage: CanonicalUsage | undefined;
    for await (const event of this.options.model.stream(request, signal)) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "usage":
          usage = event.usage;
          break;
        case "error":
          throw new Error(event.error.message);
        default:
          break;
      }
    }

    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: text.trim().length > 0 ? text : "(empty summary)" }],
      },
      usage,
    };
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
  const out: CanonicalMessage[] = [result.boundaryMarker];
  if (result.summaryMessage) {
    out.push(result.summaryMessage);
  }
  out.push(...result.messagesToKeep);
  out.push(...result.attachments);
  out.push(...result.hookResults);
  return ensureTrailingUserMessage(out);
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

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}
