import { createHash } from "node:crypto";
import {
  buildAnthropicRequest,
  buildOpenAIRequest,
  normalizeProviderBaseUrl,
  type CanonicalMessage,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalToolSchema,
  type ModelConfig,
  type ProviderConfig,
} from "../../model/index.js";
import { buildProviderHeaders } from "../../model/streaming/streamModel.js";
import { TokenBudgetManager, type TokenBudgetEvaluateOptions, type TokenBudgetSnapshot } from "./TokenBudgetManager.js";

export type TokenCountSource = "provider" | "local";

export type TokenCountResult = {
  tokens: number;
  source: TokenCountSource;
  exact: boolean;
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
};

export type EvaluateRequestBudgetOptions = CountRequestInputOptions & {
  maxContextTokens: number;
  reservedOutputTokens?: number;
  usePadding?: boolean;
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
    if (options.useProviderCount !== false) {
      const cached = this.getCachedProviderCount(request);
      if (cached) return cached;
      try {
        const counted = await this.countWithProvider(request, options.signal);
        if (counted) {
          this.setCachedProviderCount(request, counted);
          return counted;
        }
      } catch (error) {
        return {
          tokens: this.estimateRequestInput(request, { usePadding: true }),
          source: "local",
          exact: false,
          estimatorError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      tokens: this.estimateRequestInput(request, { usePadding: true }),
      source: "local",
      exact: false,
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
      displayTokens: counted.exact ? undefined : this.estimateRequestInput(request),
      budgetTokens: options.usePadding ? this.estimateRequestInput(request, { usePadding: true }) : undefined,
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
      displayTokens?: number;
      budgetTokens?: number;
    } = {},
  ): TokenBudgetSnapshot {
    return this.tokenBudget.snapshotFromTokens(tokens, maxContextTokens, metadata);
  }

  estimateMessages(messages: CanonicalMessage[], options: TokenBudgetEvaluateOptions = {}): number {
    return options.usePadding
      ? this.tokenBudget.estimateForMessagesWithPadding(messages)
      : this.tokenBudget.estimateMessagesTokens(messages);
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

  estimateRequestInput(request: CanonicalModelRequest, options: TokenBudgetEvaluateOptions = {}): number {
    const messages = options.usePadding
      ? this.tokenBudget.estimateForMessagesWithPadding(request.messages)
      : this.tokenBudget.estimateMessagesTokens(request.messages);
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
    if (isOfficialOpenAIProvider(provider)) {
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
    return { tokens: readTokenCount(raw), source: "provider", exact: true };
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
    return { tokens: readTokenCount(raw), source: "provider", exact: true };
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

function toOpenAIResponsesTokenCountBody(
  provider: ProviderConfig,
  request: CanonicalModelRequest,
): Record<string, unknown> {
  const model = provider.models[request.model];
  if (!model) throw new Error(`Model ${request.model} does not exist in provider ${provider.id}.`);
  const chatBody = buildOpenAIRequest({ ...request, stream: false }, model);
  return {
    model: chatBody.model,
    input: toOpenAIResponsesInput(chatBody.messages),
    tools: toOpenAIResponsesTools(chatBody.tools),
    tool_choice: toOpenAIResponsesToolChoice(chatBody.tool_choice),
    text: toOpenAIResponsesTextFormat(chatBody.response_format),
  };
}

function toOpenAIResponsesInput(messages: Array<Record<string, unknown>>): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role === "tool") {
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentToText(message.content),
      });
      continue;
    }

    if (role === "system" || role === "user" || role === "assistant") {
      if (message.content !== undefined) {
        input.push({
          role,
          content: toOpenAIResponsesContent(message.content),
        });
      }
      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          input.push(toOpenAIResponsesFunctionCall(toolCall));
        }
      }
    }
  }
  return input;
}

function toOpenAIResponsesContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((part) => {
    if (!isRecord(part)) {
      return part;
    }
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    if (part.type === "image_url" && isRecord(part.image_url)) {
      return {
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail,
      };
    }
    return part;
  });
}

function toOpenAIResponsesFunctionCall(toolCall: unknown): Record<string, unknown> {
  const call = isRecord(toolCall) ? toolCall : {};
  const fn = isRecord(call.function) ? call.function : {};
  return {
    type: "function_call",
    call_id: call.id,
    name: fn.name,
    arguments: typeof fn.arguments === "string" ? fn.arguments : safeJsonStringify(fn.arguments ?? {}),
  };
}

function toOpenAIResponsesTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      return tool;
    }
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    };
  });
}

function toOpenAIResponsesToolChoice(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice) || toolChoice.type !== "function" || !isRecord(toolChoice.function)) {
    return toolChoice;
  }
  return {
    type: "function",
    name: toolChoice.function.name,
  };
}

function toOpenAIResponsesTextFormat(responseFormat: unknown): unknown {
  if (!isRecord(responseFormat) || responseFormat.type !== "json_schema" || !isRecord(responseFormat.json_schema)) {
    return undefined;
  }
  return {
    format: {
      type: "json_schema",
      name: responseFormat.json_schema.name,
      description: responseFormat.json_schema.description,
      schema: responseFormat.json_schema.schema,
      strict: responseFormat.json_schema.strict,
    },
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return safeJsonStringify(content);
  }
  return content.map((part) => {
    if (typeof part === "string") {
      return part;
    }
    if (isRecord(part) && typeof part.text === "string") {
      return part.text;
    }
    return safeJsonStringify(part);
  }).join("\n");
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
    }))
    .digest("hex");
}

function isOfficialOpenAIProvider(provider: ProviderConfig): boolean {
  const normalized = normalizeProviderBaseUrl(provider.url);
  return provider.protocol === "openai" && (
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
