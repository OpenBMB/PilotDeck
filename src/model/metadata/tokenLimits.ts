import type { ModelProtocol } from "../protocol/canonical.js";
import { ANTHROPIC_DEFAULT_CAPABILITIES } from "../providers/anthropic/defaults.js";
import { GOOGLE_DEFAULT_CAPABILITIES } from "../providers/google/defaults.js";
import { OPENAI_DEFAULT_CAPABILITIES } from "../providers/openai/defaults.js";

export const TOKEN_LIMIT_KEYS = ["maxContextTokens", "maxOutputTokens"] as const;
export type TokenLimitKey = typeof TOKEN_LIMIT_KEYS[number];
export type TokenLimits = Partial<Record<TokenLimitKey, number>>;
export type TokenLimitSource = "user" | "provider" | "catalog" | "protocol";
export type ResolvedTokenLimits = Record<TokenLimitKey, { value: number; source: TokenLimitSource }>;
export type TokenLimitOverrides = Partial<Record<TokenLimitKey, boolean>>;
export type ProviderModelMetadata = TokenLimits & { id: string; displayName: string };

export function positiveTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Shared by discovery and the browser. Input limits are not added to output limits. */
export function normalizeProviderTokenLimits(value: unknown): TokenLimits {
  const item = record(value);
  const info = record(item.model_info);
  const top = record(item.top_provider);
  const first = (...values: unknown[]) => values.map(positiveTokenLimit).find(v => v !== undefined);
  const context = first(
    item.maxContextTokens, item.context_window, item.context_length,
    item.max_input_tokens, item.inputTokenLimit, info.context_window,
  );
  const output = first(
    item.maxOutputTokens, item.max_output_tokens, item.max_tokens,
    item.outputTokenLimit, top.max_completion_tokens, info.max_output_tokens,
  );
  return { ...(context !== undefined ? { maxContextTokens: context } : {}), ...(output !== undefined ? { maxOutputTokens: output } : {}) };
}

export function normalizeModelListItem(value: unknown): ProviderModelMetadata | null {
  const item = record(value);
  const id = (typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "").replace(/^models\//, "").trim();
  if (!id) return null;
  const displayName = [item.displayName, item.display_name].find(v => typeof v === "string" && v.trim());
  return { id, displayName: typeof displayName === "string" ? displayName.trim() : id, ...normalizeProviderTokenLimits(item) };
}

export function parseModelListResponse(value: unknown): ProviderModelMetadata[] {
  const body = record(value);
  const items = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models = new Map<string, ProviderModelMetadata>();
  for (const item of items) {
    const normalized = normalizeModelListItem(item);
    if (normalized) models.set(normalized.id, { ...models.get(normalized.id), ...normalized });
  }
  return [...models.values()];
}

export function protocolTokenLimits(protocol: ModelProtocol): Required<TokenLimits> {
  const defaults = protocol === "anthropic" ? ANTHROPIC_DEFAULT_CAPABILITIES : protocol === "google" ? GOOGLE_DEFAULT_CAPABILITIES : OPENAI_DEFAULT_CAPABILITIES;
  return { maxContextTokens: defaults.maxContextTokens, maxOutputTokens: defaults.maxOutputTokens };
}

export function resolveTokenLimits(input: {
  protocol: ModelProtocol;
  user?: TokenLimits;
  explicit?: TokenLimitOverrides;
  provider?: TokenLimits;
  catalog?: TokenLimits;
}): ResolvedTokenLimits {
  const defaults = protocolTokenLimits(input.protocol);
  const automatic = (key: TokenLimitKey) => {
    for (const source of ["provider", "catalog"] as const) {
      const value = positiveTokenLimit(input[source]?.[key]);
      if (value !== undefined) return { value, source };
    }
    return { value: defaults[key], source: "protocol" as const };
  };
  // Old dialogs persisted this exact pair even without an edit. A marker lets
  // users deliberately pin the same numbers after upgrading, without changing YAML on read.
  const legacyPair = TOKEN_LIMIT_KEYS.every(key => input.user?.[key] === defaults[key] && !input.explicit?.[key]);
  const migrate = legacyPair && TOKEN_LIMIT_KEYS.some(key => automatic(key).value !== defaults[key]);
  const resolve = (key: TokenLimitKey) => {
    const user = positiveTokenLimit(input.user?.[key]);
    return user !== undefined && !migrate ? { value: user, source: "user" as const } : automatic(key);
  };
  return { maxContextTokens: resolve("maxContextTokens"), maxOutputTokens: resolve("maxOutputTokens") };
}

/** Keep other capabilities intact, while persisting only real user overrides. */
export function tokenLimitSettingsPatch(input: {
  capabilities: Record<string, unknown>;
  values: Required<TokenLimits>;
  automatic: ResolvedTokenLimits;
}): { capabilities: Record<string, unknown>; tokenLimitOverrides: TokenLimitOverrides } {
  const capabilities = { ...input.capabilities };
  delete capabilities.contextWindow;
  const tokenLimitOverrides: TokenLimitOverrides = {};
  for (const key of TOKEN_LIMIT_KEYS) {
    if (input.values[key] !== input.automatic[key].value) {
      capabilities[key] = input.values[key];
      tokenLimitOverrides[key] = true;
    } else delete capabilities[key];
  }
  return { capabilities, tokenLimitOverrides };
}
