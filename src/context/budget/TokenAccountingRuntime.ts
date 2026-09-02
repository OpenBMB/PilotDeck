import { createHash } from "node:crypto";
import {
  buildAnthropicRequest,
  normalizeProviderBaseUrl,
  type CanonicalMessage,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalToolSchema,
  type CanonicalUsage,
  type ModelConfig,
  type ProviderConfig,
} from "../../model/index.js";
import { buildOpenAIResponsesRequest } from "../../model/providers/openai-responses/request.js";
import { buildProviderHeaders } from "../../model/streaming/streamModel.js";
import { TokenBudgetManager, type TokenBudgetSnapshot } from "./TokenBudgetManager.js";

export type TokenCountSource = "provider" | "calibrated" | "local";

export type TokenCalibrationBaseline = {
  provider: string;
  model: string;
  actualInputTokens: number;
  estimatedInputTokens: number;
};

export type TokenCountResult = {
  tokens: number;
  source: TokenCountSource;
  exact: boolean;
  localEstimateTokens: number;
  calibration?: TokenCalibrationBaseline;
  estimatorError?: string;
};

export type TokenAccountingRuntimeOptions = {
  modelConfig: ModelConfig;
  tokenBudget?: TokenBudgetManager;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cacheSize?: number;
};

export type CountRequestInputOptions = {
  signal?: AbortSignal;
  useProviderCount?: boolean;
  calibration?: TokenCalibrationBaseline;
};

export type EvaluateRequestBudgetOptions = CountRequestInputOptions & {
  maxContextTokens: number;
  reservedOutputTokens?: number;
};

const DEFAULT_COUNT_TIMEOUT_MS = 1_500;
const DEFAULT_CACHE_SIZE = 256;

export class TokenAccountingRuntime {
  private readonly modelConfig: ModelConfig;
  private readonly tokenBudget: TokenBudgetManager;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, TokenCountResult>();

  constructor(options: TokenAccountingRuntimeOptions) {
    this.modelConfig = options.modelConfig;
    this.tokenBudget = options.tokenBudget ?? new TokenBudgetManager();
    this.transport = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COUNT_TIMEOUT_MS;
    this.cacheSize = Math.max(0, options.cacheSize ?? DEFAULT_CACHE_SIZE);
  }

  async countRequestInput(
    request: CanonicalModelRequest,
    options: CountRequestInputOptions = {},
  ): Promise<TokenCountResult> {
    const localEstimateTokens = this.estimateRequestInput(request);
    let estimatorError: string | undefined;
    if (options.useProviderCount !== false) {
      const cached = this.getCachedProviderCount(request);
      if (cached) return { ...cached, localEstimateTokens };
      try {
        const counted = await this.countWithProvider(request, options.signal);
        if (counted) {
          this.setCachedProviderCount(request, counted);
          return { ...counted, localEstimateTokens };
        }
      } catch (error) {
        estimatorError = error instanceof Error ? error.message : String(error);
      }
    }

    const calibration = matchingCalibration(request, options.calibration);
    if (calibration) {
      const correction = calibration.actualInputTokens - calibration.estimatedInputTokens;
      // A compaction or provider-side prompt transformation can substantially
      // change the request's composition. Never let one previous absolute
      // delta overwhelm the current request estimate.
      const maximumCorrection = Math.max(1, Math.floor(localEstimateTokens * 0.5));
      return {
        tokens: Math.max(1, Math.round(localEstimateTokens + clamp(correction, -maximumCorrection, maximumCorrection))),
        source: "calibrated",
        exact: false,
        localEstimateTokens,
        calibration,
        estimatorError,
      };
    }
    return {
      tokens: localEstimateTokens,
      source: "local",
      exact: false,
      localEstimateTokens,
      estimatorError,
    };
  }

  async evaluateRequestBudget(
    request: CanonicalModelRequest,
    options: EvaluateRequestBudgetOptions,
  ): Promise<TokenBudgetSnapshot> {
    const counted = await this.countRequestInput(request, options);
    return this.snapshotFromTokens(counted.tokens, options.maxContextTokens, {
      reservedOutputTokens: options.reservedOutputTokens,
      source: counted.source,
      exact: counted.exact,
      estimatorError: counted.estimatorError,
      usageTokens: counted.source === "local" ? undefined : counted.tokens,
      localEstimateTokens: counted.localEstimateTokens,
      calibrationActualInputTokens: counted.calibration?.actualInputTokens,
      calibrationEstimatedInputTokens: counted.calibration?.estimatedInputTokens,
    });
  }

  snapshotFromTokens(
    tokens: number,
    maxContextTokens: number,
    metadata: {
      reservedOutputTokens?: number;
      source?: TokenCountSource;
      exact?: boolean;
      estimatorError?: string;
      usageTokens?: number;
      localEstimateTokens?: number;
      displayTokens?: number;
      calibrationActualInputTokens?: number;
      calibrationEstimatedInputTokens?: number;
    } = {},
  ): TokenBudgetSnapshot {
    return this.tokenBudget.snapshotFromTokens(tokens, maxContextTokens, metadata);
  }

  estimateMessages(messages: CanonicalMessage[]): number {
    return this.tokenBudget.estimateMessagesTokens(messages);
  }

  estimateResponseEvents(events: CanonicalModelEvent[]): number {
    const chunks: string[] = [];
    for (const event of events) {
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        chunks.push(event.text);
      } else if (event.type === "tool_call_delta") {
        chunks.push(event.delta);
      }
    }
    if (chunks.length === 0) return 0;
    return this.tokenBudget.estimateTextTokens(chunks.join(""));
  }

  estimateRequestInput(request: CanonicalModelRequest): number {
    const messages = this.tokenBudget.estimateMessagesTokens(request.messages);
    const system = request.systemPrompt ? this.tokenBudget.estimateTextTokens(request.systemPrompt) : 0;
    const tools = estimateToolSchemas(this.tokenBudget, request.tools ?? []);
    return messages + system + tools;
  }

  private async countWithProvider(
    request: CanonicalModelRequest,
    signal?: AbortSignal,
  ): Promise<TokenCountResult | undefined> {
    const provider = this.modelConfig.providers[request.provider];
    const model = provider?.models[request.model];
    if (!provider || !model) {
      return undefined;
    }
    if (provider.protocol === "anthropic") {
      return this.countAnthropic(provider, request, signal);
    }
    if (isOfficialOpenAIResponsesProvider(provider)) {
      return this.countOpenAI(provider, request, signal);
    }
    return undefined;
  }

  private async countAnthropic(
    provider: ProviderConfig,
    request: CanonicalModelRequest,
    signal?: AbortSignal,
  ): Promise<TokenCountResult> {
    const model = provider.models[request.model];
    if (!model) throw new Error(`Model ${request.model} does not exist in provider ${provider.id}.`);
    const fullBody = buildAnthropicRequest({ ...request, stream: false }, model);
    const body = {
      model: fullBody.model,
      messages: fullBody.messages,
      system: fullBody.system,
      tools: fullBody.tools,
      tool_choice: fullBody.tool_choice,
      thinking: fullBody.thinking,
    };
    const raw = await this.postProviderCount(provider, "v1/messages/count_tokens", body, signal);
    return { tokens: readTokenCount(raw), source: "provider", exact: true, localEstimateTokens: 0 };
  }

  private async countOpenAI(
    provider: ProviderConfig,
    request: CanonicalModelRequest,
    signal?: AbortSignal,
  ): Promise<TokenCountResult> {
    const body = toOpenAIResponsesTokenCountBody(provider, request);
    const raw = await this.postProviderCount(provider, "v1/responses/input_tokens", body, signal, {
      useOriginBase: true,
    });
    return { tokens: readTokenCount(raw), source: "provider", exact: true, localEstimateTokens: 0 };
  }

  private async postProviderCount(
    provider: ProviderConfig,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    options: { useOriginBase?: boolean } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const detach = signal ? forwardAbort(signal, controller) : undefined;
    try {
      const response = await this.transport(joinUrl(options.useOriginBase ? providerOriginUrl(provider.url) : provider.url, path), {
        method: "POST",
        headers: buildProviderHeaders(provider),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Provider token count failed with HTTP ${response.status}.`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
      detach?.();
    }
  }

  private getCachedProviderCount(request: CanonicalModelRequest): TokenCountResult | undefined {
    if (this.cacheSize === 0) return undefined;
    const key = cacheKeyForRequest(request);
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached;
  }

  private setCachedProviderCount(request: CanonicalModelRequest, result: TokenCountResult): void {
    if (this.cacheSize === 0 || result.source !== "provider") return;
    const key = cacheKeyForRequest(request);
    this.cache.set(key, result);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

export function actualInputTokensFromUsage(usage: CanonicalUsage | undefined): number | undefined {
  if (!usage) return undefined;
  let total = 0;
  for (const tokens of [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]) {
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
      total += tokens;
    }
  }
  return total > 0 ? Math.ceil(total) : undefined;
}

function matchingCalibration(
  request: CanonicalModelRequest,
  calibration: TokenCalibrationBaseline | undefined,
): TokenCalibrationBaseline | undefined {
  if (!calibration || calibration.provider !== request.provider || calibration.model !== request.model) {
    return undefined;
  }
  if (!Number.isFinite(calibration.actualInputTokens) || calibration.actualInputTokens <= 0) {
    return undefined;
  }
  if (!Number.isFinite(calibration.estimatedInputTokens) || calibration.estimatedInputTokens <= 0) {
    return undefined;
  }
  return calibration;
}

function toOpenAIResponsesTokenCountBody(
  provider: ProviderConfig,
  request: CanonicalModelRequest,
): Record<string, unknown> {
  const model = provider.models[request.model];
  if (!model) throw new Error(`Model ${request.model} does not exist in provider ${provider.id}.`);
  const fullBody = buildOpenAIResponsesRequest({ ...request, stream: false }, model, provider);
  const {
    model: responseModel,
    input,
    instructions,
    tools,
    tool_choice: toolChoice,
    text,
    reasoning,
    enable_thinking: enableThinking,
    thinking_budget: thinkingBudget,
  } = fullBody;
  return omitUndefined({
    model: responseModel,
    input,
    instructions,
    tools,
    tool_choice: toolChoice,
    text,
    reasoning,
    enable_thinking: enableThinking,
    thinking_budget: thinkingBudget,
  });
}

function estimateToolSchemas(tokenBudget: TokenBudgetManager, tools: CanonicalToolSchema[]): number {
  if (tools.length === 0) return 0;
  let total = 0;
  for (const tool of tools) {
    total += tokenBudget.estimateTextTokens(`${tool.name}${tool.description ?? ""}${safeJsonStringify(tool.inputSchema)}`);
  }
  return total;
}

function cacheKeyForRequest(request: CanonicalModelRequest): string {
  return createHash("sha256")
    .update(stableJson({
      provider: request.provider,
      model: request.model,
      messages: request.messages,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      toolChoice: request.toolChoice,
      thinking: request.thinking,
      outputSchema: request.outputSchema,
      cacheBreakpoints: request.cacheBreakpoints,
      cachePlan: request.cachePlan,
    }))
    .digest("hex");
}

function isOfficialOpenAIResponsesProvider(provider: ProviderConfig): boolean {
  const normalized = normalizeProviderBaseUrl(provider.url);
  return provider.protocol === "openai-responses" && (
    normalized === "https://api.openai.com" ||
    normalized === "https://api.openai.com/v1"
  );
}

function providerOriginUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return raw;
  }
}

function readTokenCount(raw: unknown): number {
  if (isRecord(raw)) {
    const direct = readNumber(raw.input_tokens) ?? readNumber(raw.inputTokens) ?? readNumber(raw.tokens);
    if (direct !== undefined) return direct;
  }
  throw new Error("Provider token count response did not include input_tokens.");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function omitUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function joinUrl(base: string, path: string): string {
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${cleanBase}/${cleanPath}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
