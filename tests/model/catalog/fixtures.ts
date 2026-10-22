const MODELS_DEV_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "alibaba-cn",
  "deepseek",
  "minimax",
  "moonshotai-cn",
  "volcengine",
  "zai",
] as const;

export function modelsDevFixture() {
  return Object.fromEntries(MODELS_DEV_PROVIDER_IDS.map((providerId) => [
    providerId,
    {
      models: {
        [`fixture-${providerId}`]: {
          name: `Fixture ${providerId}`,
          type: "chat",
          tool_call: true,
          structured_output: true,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          limit: { context: 200_000, output: 16_384 },
          modalities: { input: ["text", "image"] },
          cost: { input: 1, output: 2, cache_read: 0.1 },
          status: "active",
          last_updated: "2026-10-01",
          release_date: "2026-09-20",
        },
      },
    },
  ]));
}

export function openRouterFixture() {
  return {
    data: [
      {
        id: "vendor/fixture:batch",
        name: "Fixture Batch",
        supported_parameters: ["tools", "reasoning", "structured_outputs"],
        context_length: 128_000,
        top_provider: { max_completion_tokens: 8_192 },
        architecture: { input_modalities: ["text", "image"] },
        pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
        created: 1_700_000_000,
      },
      {
        id: "vendor/no-tools",
        name: "No Tools",
        supported_parameters: [],
        context_length: 128_000,
        top_provider: { max_completion_tokens: 8_192 },
        pricing: {},
      },
    ],
  };
}
