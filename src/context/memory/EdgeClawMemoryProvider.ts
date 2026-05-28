import { canonicalMessagesToMemoryMessages, type MemoryCaptureTurnInput, type MemoryResolver, type MemoryRetrieveInput, type MemoryRetrieveResult, type ContextMemoryMessage } from "./MemoryResolver.js";

type EdgeClawCaseTraceRecord = {
  sessionKey: string;
  query: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "interrupted" | "error";
  retrieval?: {
    intent?: string;
    injected: boolean;
    contextPreview: string;
    preflightReason?: string;
    trace: unknown;
  };
  toolEvents: unknown[];
  assistantReply: string;
};

export type EdgeClawRetrieveContextResult = {
  systemContext?: string;
  context?: string;
  trace?: unknown;
  debug?: {
    mode?: string;
    route?: string;
    [key: string]: unknown;
  };
  intent?: string;
};

export type EdgeClawCaptureTurnResult = {
  captured: boolean;
  normalizedMessages: ContextMemoryMessage[];
  sessionKey: string;
};

export type EdgeClawMemoryServiceLike = {
  retrieveContext(
    query: string,
    options?: {
      recentMessages?: ContextMemoryMessage[];
      workspaceHint?: string;
      retrievalMode?: "auto" | "explicit";
      signal?: AbortSignal;
    },
  ): Promise<EdgeClawRetrieveContextResult>;
  captureTurn(
    rawMessages: readonly unknown[],
    input: {
      sessionKey: string;
      timestamp?: string;
      source?: string;
    },
  ): EdgeClawCaptureTurnResult;
  saveCaseTrace?(record: EdgeClawCaseTraceRecord): void;
};

export type EdgeClawMemoryProviderOptions = {
  service: EdgeClawMemoryServiceLike;
  retrievalMode?: "auto" | "explicit";
  source?: string;
  now?: () => Date;
};

export class EdgeClawMemoryProvider implements MemoryResolver {
  private readonly now: () => Date;
  private readonly pendingRetrievals = new Map<string, {
    query: string;
    startedAt: string;
    result: EdgeClawRetrieveContextResult;
  }>();

  constructor(private readonly options: EdgeClawMemoryProviderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    const startedAt = this.now().toISOString();
    try {
      const recentMessages = canonicalMessagesToMemoryMessages(input.recentMessages);
      const result = await this.options.service.retrieveContext(input.query, {
        recentMessages,
        workspaceHint: input.projectRoot,
        retrievalMode: this.options.retrievalMode ?? "auto",
        signal: input.signal,
      });
      this.pendingRetrievals.set(input.sessionId, {
        query: input.query,
        startedAt,
        result,
      });
      const systemContext = (result.systemContext ?? result.context ?? "").trim();
      if (!systemContext) {
        return {
          diagnostics: [
            {
              code: "memory_context_empty",
              severity: "info",
              message: "EdgeClaw memory returned no relevant context.",
            },
          ],
          metadata: { trace: result.trace, debug: result.debug },
        };
      }

      return {
        systemContext,
        diagnostics: [],
        metadata: { trace: result.trace, debug: result.debug },
      };
    } catch (error) {
      return {
        diagnostics: [
          {
            code: "memory_provider_error",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  async captureTurn(input: MemoryCaptureTurnInput): Promise<void> {
    const normalizedMessages = canonicalMessagesToMemoryMessages(input.messages);
    try {
      this.options.service.captureTurn(normalizedMessages, {
        sessionKey: input.sessionId,
        timestamp: this.now().toISOString(),
        source: this.options.source ?? "pilotdeck",
      });
    } catch {
      // Memory capture should not break the agent turn.
    }
    this.savePendingCaseTrace(input, normalizedMessages);
  }

  private savePendingCaseTrace(input: MemoryCaptureTurnInput, normalizedMessages: ContextMemoryMessage[]): void {
    const saveCaseTrace = this.options.service.saveCaseTrace?.bind(this.options.service);
    if (!saveCaseTrace) return;
    const pending = this.pendingRetrievals.get(input.sessionId);
    if (!pending) return;
    this.pendingRetrievals.delete(input.sessionId);

    const contextPreview = (pending.result.systemContext ?? pending.result.context ?? "").trim();
    try {
      saveCaseTrace({
        sessionKey: input.sessionId,
        query: pending.query,
        startedAt: pending.startedAt,
        finishedAt: this.now().toISOString(),
        status: input.errored ? "error" : "completed",
        retrieval: {
          intent: pending.result.intent ?? pending.result.debug?.route ?? pending.result.debug?.mode ?? "none",
          injected: contextPreview.length > 0,
          contextPreview,
          trace: pending.result.trace ?? null,
        },
        toolEvents: [],
        assistantReply: extractLastAssistantText(normalizedMessages),
      });
    } catch {
      // Trace persistence is observational and must not break memory capture.
    }
  }
}

function extractLastAssistantText(messages: readonly ContextMemoryMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return "";
}
