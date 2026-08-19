import type { CanonicalModelEvent } from "../protocol/canonical.js";
import type { StreamInterruption } from "../protocol/errors.js";
import { hasTextToolCallSyntax } from "./parseTextToolCalls.js";

export interface StreamingCheckpoint {
  partialText: string;
  tokensReceived: number;
  hasToolCalls: boolean;
  hasReasoning: boolean;
  activeToolCalls: Map<string, { name: string; argumentChars: number }>;
}

/**
 * Lightweight tracker that accumulates partial assistant content from a
 * streaming model response. Used by the stream-retry logic in `streamModel`
 * to decide whether a mid-stream failure has enough partial content to
 * warrant a continuation retry (as opposed to a full from-scratch retry).
 */
export class StreamingCheckpointManager {
  private checkpoint: StreamingCheckpoint = {
    partialText: "",
    tokensReceived: 0,
    hasToolCalls: false,
    hasReasoning: false,
    activeToolCalls: new Map(),
  };

  onEvent(event: CanonicalModelEvent): void {
    switch (event.type) {
      case "text_delta":
        this.checkpoint.partialText += event.text;
        this.checkpoint.tokensReceived++;
        break;
      case "thinking_delta":
        this.checkpoint.hasReasoning = true;
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_start":
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.activeToolCalls.set(event.id, { name: event.name, argumentChars: 0 });
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_delta": {
        this.checkpoint.hasToolCalls = true;
        const active = this.checkpoint.activeToolCalls.get(event.id) ?? { name: "", argumentChars: 0 };
        active.argumentChars += event.delta.length;
        this.checkpoint.activeToolCalls.set(event.id, active);
        this.checkpoint.tokensReceived++;
        break;
      }
      case "tool_call_end":
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.activeToolCalls.delete(event.toolCall.id);
        this.checkpoint.tokensReceived++;
        break;
    }
  }

  get(): StreamingCheckpoint {
    return {
      ...this.checkpoint,
      activeToolCalls: new Map(this.checkpoint.activeToolCalls),
    };
  }

  hasSubstantialContent(): boolean {
    return this.checkpoint.partialText.trim().length > 0;
  }

  canContinueText(): boolean {
    return this.hasSubstantialContent()
      && !hasTextToolCallSyntax(this.checkpoint.partialText)
      && !this.checkpoint.hasReasoning
      && !this.checkpoint.hasToolCalls;
  }

  interruption(): StreamInterruption {
    const activeToolCalls = [...this.checkpoint.activeToolCalls.entries()].map(([id, call]) => ({ id, ...call }));
    if (this.checkpoint.hasToolCalls) {
      return { phase: "tool_call", activeToolCalls };
    }
    if (this.checkpoint.partialText.trim().length > 0) {
      return { phase: "text" };
    }
    if (this.checkpoint.hasReasoning) {
      return { phase: "reasoning" };
    }
    return { phase: "empty" };
  }

  reset(): void {
    this.checkpoint = {
      partialText: "",
      tokensReceived: 0,
      hasToolCalls: false,
      hasReasoning: false,
      activeToolCalls: new Map(),
    };
  }
}
