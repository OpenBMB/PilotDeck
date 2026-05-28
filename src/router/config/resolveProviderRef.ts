import type { ModelConfig } from "../../model/index.js";
import type { RouterModelRef } from "./schema.js";

export function parseProviderModelRef(value: string): RouterModelRef {
  const separatorIndex = value.indexOf("/");
  const provider = separatorIndex >= 0 ? value.slice(0, separatorIndex) : "";
  const model = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : "";
  return { id: value, provider, model };
}

export function isValidProviderModelRef(value: string, modelConfig: ModelConfig): boolean {
  const parsed = parseProviderModelRef(value);
  return Boolean(parsed.provider && parsed.model && modelConfig.providers[parsed.provider]?.models[parsed.model]);
}
