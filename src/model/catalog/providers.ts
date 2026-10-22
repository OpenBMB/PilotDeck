import type { ModelCapabilities } from "../protocol/capabilities.js";
import type { MultimodalConstraints } from "../protocol/multimodal.js";
import type { CatalogModelEntry, ProviderCatalog } from "./types.js";

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const TEXT_ONLY: MultimodalConstraints = { input: ["text"] };

const TEXT_IMAGE: MultimodalConstraints = {
  input: ["text", "image"],
  maxImagesPerRequest: 20,
  supportedImageMimeTypes: IMAGE_MIME_TYPES,
  imageDetail: "auto",
};

const TEXT_IMAGE_10: MultimodalConstraints = {
  ...TEXT_IMAGE,
  maxImagesPerRequest: 10,
  supportedImageMimeTypes: ["image/jpeg", "image/png", "image/webp"],
};

const TEXT_IMAGE_PDF: MultimodalConstraints = {
  ...TEXT_IMAGE,
  input: ["text", "image", "pdf"],
};

const GEMINI_MULTIMODAL: MultimodalConstraints = {
  ...TEXT_IMAGE,
  input: ["text", "image", "audio", "pdf"],
};

type ModelOptions = {
  aliases?: string[];
  capabilities?: Partial<ModelCapabilities>;
};

function model(
  displayName: string,
  maxContextTokens: number,
  maxOutputTokens: number,
  multimodal: MultimodalConstraints,
  options: ModelOptions = {},
): CatalogModelEntry {
  return {
    displayName,
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: true,
      supportsJsonSchema: true,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      ...options.capabilities,
      maxContextTokens,
      maxOutputTokens,
    },
    multimodal,
    ...(options.aliases?.length ? { aliases: options.aliases } : {}),
  };
}

function anthropicModel(
  displayName: string,
  maxContextTokens: number,
  maxOutputTokens: number,
  aliases: string[] = [],
): CatalogModelEntry {
  return model(displayName, maxContextTokens, maxOutputTokens, TEXT_IMAGE_PDF, {
    aliases,
    capabilities: {
      supportsParallelToolCalls: false,
      supportsPromptCache: true,
    },
  });
}

function openaiModel(
  displayName: string,
  maxContextTokens: number,
  maxOutputTokens: number,
  options: ModelOptions & { supportsThinking?: boolean; supportsParallelToolCalls?: boolean },
): CatalogModelEntry {
  return model(displayName, maxContextTokens, maxOutputTokens, TEXT_IMAGE, {
    aliases: options.aliases,
    capabilities: {
      supportsThinking: options.supportsThinking ?? true,
      supportsParallelToolCalls: options.supportsParallelToolCalls ?? true,
      supportsPromptCache: true,
      ...options.capabilities,
    },
  });
}

function openaiChatModel(
  displayName: string,
  maxContextTokens: number,
  maxOutputTokens: number,
  options: ModelOptions & { supportsThinking?: boolean; supportsParallelToolCalls?: boolean } = {},
): CatalogModelEntry {
  return openaiModel(displayName, maxContextTokens, maxOutputTokens, options);
}

function googleModel(
  displayName: string,
  maxContextTokens: number,
  maxOutputTokens: number,
  aliases: string[] = [],
): CatalogModelEntry {
  return model(displayName, maxContextTokens, maxOutputTokens, GEMINI_MULTIMODAL, { aliases });
}

// Model lineups are checked against each vendor's model catalogue.
// Last verified: 2026-10-22.
export const PROVIDER_CATALOG: ProviderCatalog = {

  // ── Anthropic ──────────────────────────────────────────────────────────

  anthropic: {
    displayName: "Anthropic",
    protocol: "anthropic",
    defaultUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    models: {
      "claude-fable-5-1": anthropicModel("Claude Fable 5.1", 1_000_000, 128_000, ["claude-fable-5.1"]),
      "claude-opus-5-5": anthropicModel("Claude Opus 5.5", 1_000_000, 128_000, ["claude-opus-5.5"]),
      "claude-sonnet-5-5": anthropicModel("Claude Sonnet 5.5", 1_000_000, 128_000, ["claude-sonnet-5.5"]),
      "claude-haiku-5-5": anthropicModel("Claude Haiku 5.5", 1_000_000, 128_000, ["claude-haiku-5.5"]),
      "claude-fable-5": anthropicModel("Claude Fable 5", 1_000_000, 128_000, ["claude-fable-5"]),
      "claude-opus-5": anthropicModel("Claude Opus 5", 1_000_000, 128_000, ["claude-opus-5"]),
      "claude-opus-4-8": anthropicModel("Claude Opus 4.8", 1_000_000, 128_000, ["claude-opus-4.8"]),
      "claude-opus-4-7": anthropicModel("Claude Opus 4.7", 1_000_000, 128_000, ["claude-opus-4.7"]),
      "claude-opus-4-6": anthropicModel("Claude Opus 4.6", 1_000_000, 128_000, ["claude-opus-4.6"]),
      "claude-opus-4-5-20251101": anthropicModel("Claude Opus 4.5", 200_000, 64_000, [
        "claude-opus-4-5",
        "claude-opus-4.5",
      ]),
      "claude-sonnet-5": anthropicModel("Claude Sonnet 5", 1_000_000, 128_000, ["claude-sonnet-5"]),
      "claude-sonnet-4-6": anthropicModel("Claude Sonnet 4.6", 1_000_000, 128_000, [
        "claude-sonnet-4-6",
        "claude-sonnet-4.6",
      ]),
      "claude-sonnet-4-5-20250929": anthropicModel("Claude Sonnet 4.5", 200_000, 64_000, [
        "claude-sonnet-4-5",
        "claude-sonnet-4.5",
        "claude-3-5-sonnet-20250929",
      ]),
      "claude-haiku-4-5-20251001": anthropicModel("Claude Haiku 4.5", 200_000, 64_000, [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
      ]),
    },
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────
  // Chat Completions-compatible models. Models that need the Responses API
  // for tool calling live in `openai-responses` below.

  openai: {
    displayName: "OpenAI",
    protocol: "openai",
    defaultUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    models: {
      "gpt-6-astra": openaiChatModel("GPT-6 Astra", 1_050_000, 128_000),
      "gpt-5.6-sol": openaiChatModel("GPT-5.6 Sol", 1_050_000, 128_000),
      "gpt-5.6-terra": openaiChatModel("GPT-5.6 Terra", 1_050_000, 128_000),
      "gpt-5.6-luna": openaiChatModel("GPT-5.6 Luna", 1_050_000, 128_000),
      "gpt-5.5": openaiChatModel("GPT-5.5", 1_050_000, 128_000),
      "gpt-5.4": openaiChatModel("GPT-5.4", 1_050_000, 128_000),
      "gpt-5.4-mini": openaiChatModel("GPT-5.4 Mini", 400_000, 128_000),
      "gpt-5.4-nano": openaiChatModel("GPT-5.4 Nano", 400_000, 128_000),
      "gpt-5.2": openaiChatModel("GPT-5.2", 400_000, 128_000),
      "gpt-5.1": openaiChatModel("GPT-5.1", 400_000, 128_000),
      "gpt-5": openaiChatModel("GPT-5", 400_000, 128_000),
      "gpt-4.1": openaiChatModel("GPT-4.1", 1_047_576, 32_768, { supportsThinking: false }),
      "gpt-4.1-mini": openaiChatModel("GPT-4.1 Mini", 1_047_576, 32_768, { supportsThinking: false }),
      "gpt-4o": openaiChatModel("GPT-4o", 128_000, 16_384, {
        aliases: ["gpt-4o-2024-11-20"],
        supportsThinking: false,
        capabilities: { supportsPromptCache: false },
      }),
      "gpt-4o-mini": openaiChatModel("GPT-4o Mini", 128_000, 16_384, {
        supportsThinking: false,
        capabilities: { supportsPromptCache: false },
      }),
      "o3": openaiChatModel("o3", 200_000, 100_000, { supportsParallelToolCalls: false }),
      "o4-mini": openaiChatModel("o4-mini", 200_000, 100_000, { supportsParallelToolCalls: false }),
    },
  },

  // ── OpenAI Responses API ──────────────────────────────────────────────
  // Full current lineup; prefer this provider for tool-using agents.

  "openai-responses": {
    displayName: "OpenAI (Responses API)",
    protocol: "openai-responses",
    defaultUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    models: {
      "gpt-6.1-sol": openaiModel("GPT-6.1 Sol", 1_050_000, 128_000, {}),
      "gpt-6-astra": openaiModel("GPT-6 Astra", 1_050_000, 128_000, {}),
      "gpt-6-sol": openaiModel("GPT-6 Sol", 1_050_000, 128_000, {}),
      "gpt-6-luna": openaiModel("GPT-6 Luna", 1_050_000, 128_000, {}),
      "gpt-5.6-sol": openaiModel("GPT-5.6 Sol", 1_050_000, 128_000, {}),
      "gpt-5.6-terra": openaiModel("GPT-5.6 Terra", 1_050_000, 128_000, {}),
      "gpt-5.6-luna": openaiModel("GPT-5.6 Luna", 1_050_000, 128_000, {}),
      "gpt-5.5-pro": openaiModel("GPT-5.5 Pro", 1_050_000, 128_000, {}),
      "gpt-5.5": openaiModel("GPT-5.5", 1_050_000, 128_000, {}),
      "gpt-5.4-pro": openaiModel("GPT-5.4 Pro", 1_050_000, 128_000, {}),
      "gpt-5.4": openaiModel("GPT-5.4", 1_050_000, 128_000, {}),
      "gpt-5.4-mini": openaiModel("GPT-5.4 Mini", 400_000, 128_000, {}),
      "gpt-5.4-nano": openaiModel("GPT-5.4 Nano", 400_000, 128_000, {}),
      "gpt-5.3-codex": openaiModel("GPT-5.3 Codex", 400_000, 128_000, {}),
      "gpt-5.2": openaiModel("GPT-5.2", 400_000, 128_000, {}),
      "gpt-5.1": openaiModel("GPT-5.1", 400_000, 128_000, {}),
      "gpt-5": openaiModel("GPT-5", 400_000, 128_000, {}),
      "gpt-4.1": openaiModel("GPT-4.1", 1_047_576, 32_768, { supportsThinking: false }),
      "gpt-4.1-mini": openaiModel("GPT-4.1 Mini", 1_047_576, 32_768, { supportsThinking: false }),
      "gpt-4o": openaiModel("GPT-4o", 128_000, 16_384, {
        aliases: ["gpt-4o-2024-11-20"],
        supportsThinking: false,
        capabilities: { supportsPromptCache: false },
      }),
      "gpt-4o-mini": openaiModel("GPT-4o Mini", 128_000, 16_384, {
        supportsThinking: false,
        capabilities: { supportsPromptCache: false },
      }),
      "o3": openaiModel("o3", 200_000, 100_000, { supportsParallelToolCalls: false }),
      "o4-mini": openaiModel("o4-mini", 200_000, 100_000, { supportsParallelToolCalls: false }),
    },
  },

  // ── Alibaba Cloud Model Studio / DashScope ────────────────────────────

  dashscope: {
    displayName: "阿里云百炼 (DashScope)",
    protocol: "openai",
    defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvVar: "DASHSCOPE_API_KEY",
    models: {
      "qwen3.8-max": model("Qwen3.8 Max", 1_000_000, 131_072, TEXT_IMAGE_10),
      "qwen3.7-plus": model("Qwen3.7 Plus", 1_000_000, 131_072, TEXT_IMAGE_10),
      "qwen3.8-flash": model("Qwen3.8 Flash", 1_000_000, 131_072, TEXT_IMAGE_10),
    },
  },

  // ── DeepSeek ───────────────────────────────────────────────────────────

  deepseek: {
    displayName: "DeepSeek",
    protocol: "openai",
    defaultUrl: "https://api.deepseek.com/v1",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    models: {
      "deepseek-flash": model("DeepSeek Flash (V4.1)", 1_048_576, 393_216, TEXT_IMAGE, {
        aliases: ["deepseek-v4-flash", "deepseek-v4.1-flash"],
      }),
      "deepseek-v4-pro": model("DeepSeek V4 Pro", 1_048_576, 393_216, TEXT_ONLY, {
        aliases: ["deepseek-v4-pro-0813"],
      }),
    },
  },

  // ── Google / Gemini ────────────────────────────────────────────────────

  google: {
    displayName: "Google AI (Gemini)",
    protocol: "google",
    defaultUrl: "https://generativelanguage.googleapis.com",
    apiKeyEnvVar: "GEMINI_API_KEY",
    models: {
      "gemini-4-argon": googleModel("Gemini 4 Argon", 1_048_576, 65_536, ["gemini-4"]),
      "gemini-3.8-flash": googleModel("Gemini 3.8 Flash", 1_048_576, 65_536),
      "gemini-3.7-flash": googleModel("Gemini 3.7 Flash", 1_048_576, 65_536),
      "gemini-3.6-flash": googleModel("Gemini 3.6 Flash", 1_048_576, 65_536),
      "gemini-3.5-flash": googleModel("Gemini 3.5 Flash", 1_048_576, 65_536),
      "gemini-3.5-flash-lite": googleModel("Gemini 3.5 Flash-Lite", 1_048_576, 65_536),
      "gemini-3.1-pro-preview": googleModel("Gemini 3.1 Pro Preview", 1_048_576, 65_536, [
        "gemini-3.1-pro",
      ]),
      "gemini-3.1-flash-lite": googleModel("Gemini 3.1 Flash-Lite", 1_048_576, 65_536),
      "gemini-3-flash-preview": googleModel("Gemini 3 Flash Preview", 1_048_576, 65_536, [
        "gemini-3-flash",
      ]),
      "gemini-2.5-pro": googleModel("Gemini 2.5 Pro", 1_048_576, 65_536),
      "gemini-2.5-flash": googleModel("Gemini 2.5 Flash", 1_048_576, 65_536),
      "gemini-2.5-flash-lite": googleModel("Gemini 2.5 Flash-Lite", 1_048_576, 65_536),
    },
  },

  // ── MiniMax ────────────────────────────────────────────────────────────

  minimax: {
    displayName: "MiniMax",
    protocol: "openai",
    defaultUrl: "https://api.minimax.io/v1",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    models: {
      "MiniMax-M3.1-Flash": model("MiniMax M3.1 Flash", 1_000_000, 524_288, TEXT_IMAGE, {
        aliases: ["minimax-m3.1-flash"],
      }),
      "MiniMax-M3": model("MiniMax M3", 1_048_576, 512_000, TEXT_IMAGE, {
        aliases: ["minimax-m3"],
      }),
    },
  },

  // ── Moonshot / Kimi ────────────────────────────────────────────────────

  moonshot: {
    displayName: "Moonshot AI (Kimi)",
    protocol: "openai",
    defaultUrl: "https://api.moonshot.cn/v1",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    models: {
      "kimi-k3": model("Kimi K3", 1_048_576, 131_072, TEXT_IMAGE, {
        aliases: ["moonshotai/kimi-k3"],
      }),
      "kimi-k2.7-code": model("Kimi K2.7 Code", 262_144, 131_072, TEXT_IMAGE, {
        aliases: ["moonshotai/kimi-k2.7-code"],
      }),
      "kimi-k2.7-code-highspeed": model("Kimi K2.7 Code Highspeed", 262_144, 131_072, TEXT_IMAGE, {
        aliases: ["moonshotai/kimi-k2.7-code-highspeed"],
      }),
      "kimi-k2.6": model("Kimi K2.6", 262_144, 131_072, TEXT_IMAGE, {
        aliases: ["moonshotai/kimi-k2.6"],
      }),
    },
  },

  // ── Volcano Ark (火山方舟) ────────────────────────────────────────────

  volc_ark: {
    displayName: "火山方舟 (Volcano Ark)",
    protocol: "openai",
    defaultUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnvVar: "VOLC_ARK_API_KEY",
    models: {
      "doubao-seed-evolving": model("Doubao Seed Evolving", 1_048_576, 262_144, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
      "doubao-seed-2-1-pro-260915": model("Doubao Seed 2.1 Pro (260915)", 1_048_576, 262_144, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
      "doubao-seed-2-1-lite-260915": model("Doubao Seed 2.1 Lite (260915)", 1_048_576, 262_144, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
      "doubao-seed-2-1-turbo-260628": model("Doubao Seed 2.1 Turbo (260628)", 262_144, 262_144, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
      "doubao-seed-2-1-pro-260628": model("Doubao Seed 2.1 Pro (260628)", 262_144, 262_144, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
      "doubao-seed-2-0-lite-260428": model("Doubao Seed 2.0 Lite (260428)", 262_144, 131_072, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
      "doubao-seed-2-0-mini-260428": model("Doubao Seed 2.0 Mini (260428)", 262_144, 131_072, TEXT_IMAGE_10, {
        capabilities: { supportsPromptCache: true },
      }),
    },
  },

  // ── Zhipu / Z.AI ───────────────────────────────────────────────────────

  zhipu: {
    displayName: "智谱 Z.AI",
    protocol: "openai",
    defaultUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnvVar: "ZAI_API_KEY",
    models: {
      "glm-5.3": model("GLM-5.3", 1_048_576, 131_072, TEXT_ONLY),
      "glm-5.3-flash": model("GLM-5.3 Flash", 1_048_576, 131_072, TEXT_IMAGE),
      "glm-5.3-flashx": model("GLM-5.3 FlashX", 1_048_576, 131_072, TEXT_IMAGE),
      "glm-5.2": model("GLM-5.2", 1_048_576, 131_072, TEXT_ONLY),
    },
  },

  // ── Proxy providers (no built-in models; use cross-provider lookup) ───

  openrouter: {
    displayName: "OpenRouter",
    protocol: "openai",
    defaultUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    models: {},
  },

  ollama: {
    displayName: "Ollama",
    protocol: "openai",
    defaultUrl: "http://localhost:11434/v1",
    models: {
      "qwen3:0.6b": model("Qwen3 0.6B (Ollama)", 40_960, 8_192, TEXT_ONLY, {
        capabilities: {
          supportsParallelToolCalls: false,
          supportsThinking: false,
          supportsJsonSchema: false,
        },
      }),
      "qwen3:8b": model("Qwen3 8B (Ollama)", 40_960, 8_192, TEXT_ONLY, {
        capabilities: {
          supportsToolUse: false,
          supportsParallelToolCalls: false,
          supportsThinking: false,
          supportsJsonSchema: false,
        },
      }),
      "llama3.1:8b": model("Llama 3.1 8B (Ollama)", 131_072, 8_192, TEXT_ONLY, {
        capabilities: {
          supportsToolUse: false,
          supportsParallelToolCalls: false,
          supportsThinking: false,
          supportsJsonSchema: false,
        },
      }),
    },
  },

};
