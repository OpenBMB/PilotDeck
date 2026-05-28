import type { CanonicalModelEvent, CanonicalUsage } from "../../model/index.js";

export type ZeroUsageState = {
  observedAnyText: boolean;
  observedFinish: boolean;
  observedUsage?: CanonicalUsage;
  observedError: boolean;
};

export function createZeroUsageState(): ZeroUsageState {
  return {
    observedAnyText: false,
    observedFinish: false,
    observedError: false,
  };
}

export function observeEventForZeroUsage(
  state: ZeroUsageState,
  event: CanonicalModelEvent,
): void {
  if (event.type === "text_delta" && event.text.length > 0) {
    state.observedAnyText = true;
  } else if (event.type === "tool_call_delta" && event.delta.length > 0) {
    state.observedAnyText = true;
  } else if (event.type === "tool_call_end") {
    state.observedAnyText = true;
  } else if (event.type === "message_end") {
    state.observedFinish = true;
  } else if (event.type === "usage") {
    state.observedUsage = event.usage;
  } else if (event.type === "error") {
    state.observedError = true;
  }
}

export function shouldRetryZeroUsage(state: ZeroUsageState): boolean {
  if (state.observedError) {
    return false;
  }
  if (!state.observedFinish) {
    return false;
  }
  if (state.observedAnyText) {
    return false;
  }
  const usage = state.observedUsage;
  if (!usage) {
    return true;
  }
  const total = totalTokens(usage);
  return total === 0;
}

function totalTokens(usage: CanonicalUsage): number {
  return (
    (usage.totalTokens ?? 0) +
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}
