import type { ModelProtocol } from "../protocol/canonical.js";
import type { ModelCapabilities } from "../protocol/capabilities.js";
import type { MultimodalConstraints } from "../protocol/multimodal.js";

export type RawModelConfig = {
  providers?: unknown;
};

export type RawProviderConfig = {
  protocol?: unknown;
  url?: unknown;
  apiKey?: unknown;
  timeoutMs?: unknown;
  headers?: unknown;
  extraBody?: unknown;
  retry?: unknown;
  models?: unknown;
};

export type RawModelDefinition = {
  displayName?: unknown;
  capabilities?: unknown;
  multimodal?: unknown;
  aliases?: unknown;
};

export type RawCapabilities = Partial<Record<keyof ModelCapabilities, unknown>>;

export type RawMultimodal = Partial<Record<keyof MultimodalConstraints, unknown>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return value === "anthropic" || value === "openai";
}
