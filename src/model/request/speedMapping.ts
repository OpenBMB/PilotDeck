import type { SpeedMapping } from "../protocol/canonical.js";

export type OpenAISpeedTier = "priority";
export type AnthropicSpeed = "fast";

/** Normalize the shared 0..1 preference to the provider's discrete tiers. */
export function mapSpeedToOpenAIServiceTier(speed: number): OpenAISpeedTier | undefined {
  if (speed >= 0.5) return "priority";
  return undefined;
}

export function mapSpeedToAnthropicSpeed(speed: number): AnthropicSpeed | undefined {
  if (speed >= 0.5) return "fast";
  return undefined;
}

export function hasSpeedMapping(mapping: SpeedMapping | undefined, expected: SpeedMapping): boolean {
  return mapping === expected;
}
