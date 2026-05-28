import type { ModelProtocol } from "../protocol/canonical.js";
import { ModelConfigError } from "../protocol/errors.js";

export type ModelProviderAdapter = {
  protocol: ModelProtocol;
  name: string;
};

const adapters: Record<ModelProtocol, ModelProviderAdapter> = {
  anthropic: { protocol: "anthropic", name: "Anthropic Messages API" },
  openai: { protocol: "openai", name: "OpenAI Chat Completions API" },
};

export const ModelProviderRegistry = {
  get(protocol: ModelProtocol): ModelProviderAdapter {
    const adapter = adapters[protocol];
    if (!adapter) {
      throw new ModelConfigError("unsupported_protocol", `Unsupported model protocol ${protocol}.`);
    }
    return adapter;
  },

  list(): ModelProviderAdapter[] {
    return Object.values(adapters);
  },
};
