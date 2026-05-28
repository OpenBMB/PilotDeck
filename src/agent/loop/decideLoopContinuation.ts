import type { CanonicalMessage } from "../../model/index.js";
import { collectToolCalls } from "./collectToolCalls.js";

export type LoopContinuationDecision =
  | { type: "continue"; reason: "tool_results" }
  | { type: "stop"; reason: "no_tool_calls" };

export function decideLoopContinuation(message: CanonicalMessage): LoopContinuationDecision {
  return collectToolCalls(message).length > 0
    ? { type: "continue", reason: "tool_results" }
    : { type: "stop", reason: "no_tool_calls" };
}
