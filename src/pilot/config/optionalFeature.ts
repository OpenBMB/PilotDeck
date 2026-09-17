/**
 * Missing optional features are off. Existing sections without an enabled flag
 * retain their legacy opt-in meaning; explicit true/false always wins.
 * Used for routing, memory and web search, not channel adapters.
 */
export function isOptionalFeatureEnabled(config: { enabled?: boolean } | null | undefined): boolean {
  return config != null && config.enabled !== false;
}
