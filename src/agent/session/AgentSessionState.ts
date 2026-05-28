import { cloneMessages, type CanonicalMessage, type CanonicalUsage } from "../../model/index.js";
import type { AgentPermissionDenial } from "../protocol/result.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";

export function createInitialAgentSessionState(sessionId: string): AgentSessionStateShape {
  return {
    sessionId,
    messages: [],
    usage: {},
    permissionDenials: [],
    status: "idle",
    abortController: new AbortController(),
  };
}

export function snapshotAgentSessionState(state: AgentSessionStateShape): AgentSessionStateShape {
  return {
    ...state,
    messages: cloneMessages(state.messages),
    usage: { ...state.usage },
    permissionDenials: state.permissionDenials.map((denial) => ({ ...denial })),
  };
}

export function cloneSessionStateForRuntimeReload(state: AgentSessionStateShape): AgentSessionStateShape {
  return {
    ...snapshotAgentSessionState(state),
    status: "idle",
    currentTurnId: undefined,
    abortController: new AbortController(),
  };
}

export function mergeSessionUsage(first: CanonicalUsage, second: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

export function appendPermissionDenials(
  first: AgentPermissionDenial[],
  second: AgentPermissionDenial[],
): AgentPermissionDenial[] {
  return [...first, ...second.map((denial) => ({ ...denial }))];
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}
