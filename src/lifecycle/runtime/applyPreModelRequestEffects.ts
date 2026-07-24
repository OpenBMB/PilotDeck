import type { CanonicalModelRequest } from "../../model/index.js";
import type { LifecycleDispatchResult } from "../protocol/payloads.js";

export type PreModelRequestTransformResult =
  | { type: "blocked"; reason: string; stopReason?: string }
  | { type: "ready"; request: CanonicalModelRequest };

/** Applies the deliberately restricted set of mutations allowed immediately before routing. */
export function applyPreModelRequestEffects(
  request: CanonicalModelRequest,
  result: LifecycleDispatchResult,
): PreModelRequestTransformResult {
  const blocked = result.effects.find((effect) => effect.type === "block");
  if (blocked) return { type: "blocked", reason: blocked.reason, stopReason: blocked.stopReason };

  let next: CanonicalModelRequest = result.messages.length > 0
    ? { ...request, messages: [...request.messages, ...result.messages] }
    : request;

  for (const effect of result.effects) {
    if (effect.type === "system_message") {
      next = {
        ...next,
        systemPrompt: [next.systemPrompt, effect.content].filter(Boolean).join("\n\n"),
      };
      continue;
    }
    if (effect.type === "model_request_patch") {
      next = {
        ...next,
        ...effect.patch,
        metadata: effect.patch.metadata
          ? { ...(next.metadata ?? {}), ...effect.patch.metadata }
          : next.metadata,
      };
    }
  }

  return { type: "ready", request: next };
}
