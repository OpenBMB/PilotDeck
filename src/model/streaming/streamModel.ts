import { normalizeModelError } from "../errors/normalizeModelError.js";
import { createGoogleClient, type GoogleClientFactory } from "../providers/google/client.js";
import { parseGoogleResponse } from "../providers/google/response.js";
import type { GoogleRequestBody } from "../providers/google/request.js";
import { buildModelRequest } from "../request/buildModelRequest.js";
import { validateModelRequest } from "../request/validateModelRequest.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelConfig,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";
import { ModelProviderError, parseRetryAfterHeader } from "../protocol/errors.js";
import { parseModelResponse } from "../response/parseModelResponse.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "./normalizeStreamEvent.js";
import { createGoogleStreamState, normalizeGoogleStreamEvent } from "../providers/google/stream.js";
import { normalizeProviderBaseUrl } from "../normalizeProviderBaseUrl.js";
import { StreamingCheckpointManager } from "./StreamingCheckpoint.js";

export type ModelTransport = typeof fetch;

export type ModelRuntimeOptions = {
  fetch?: ModelTransport;
  googleClientFactory?: GoogleClientFactory;
  signal?: AbortSignal;
};

const DEFAULT_REQUEST_MAX_RETRIES = 2;

export async function complete(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
) {
  const nonStreamingRequest = { ...request, stream: false };
  const { provider } = validateModelRequest(nonStreamingRequest, config);
  const maxRetries = provider.retry?.requestMaxRetries ?? DEFAULT_REQUEST_MAX_RETRIES;
  const retryBaseDelay = provider.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    if (provider.protocol === "google") {
      try {
        const raw = await sendGoogleCompleteRequest(
          provider,
          nonStreamingRequest,
          options,
        );
        return parseGoogleResponse(raw, provider.id);
      } catch (error) {
        if (attempt < maxRetries && isRetryableRequestError(error)) {
          const delayMs = retryBaseDelay * (attempt + 1);
          console.warn(
            `[PilotDeck] complete() retry: ${(error as Error).message} ` +
            `(attempt ${attempt + 1}/${maxRetries}, delay=${delayMs}ms)`,
          );
          await delay(delayMs, options.signal);
          continue;
        }
        throw error;
      }
    }

    const body = buildModelRequest(nonStreamingRequest, config);
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, false, options.fetch ?? fetch, options.signal);
    } catch (error) {
      if (attempt < maxRetries && isRetryableRequestError(error)) {
        const delayMs = retryBaseDelay * (attempt + 1);
        console.warn(
          `[PilotDeck] complete() retry: ${(error as Error).message} ` +
          `(attempt ${attempt + 1}/${maxRetries}, delay=${delayMs}ms)`,
        );
        await delay(delayMs, options.signal);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      throw new ModelProviderError(
        normalizeModelError(provider.id, provider.protocol, raw, response.status),
      );
    }

    const raw = await response.json();
    return parseModelResponse(provider.protocol, raw, provider.id);
  }

  throw new Error("complete() exhausted all retry attempts without a result.");
}

const DEFAULT_STREAM_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

export async function* streamModel(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): AsyncIterable<CanonicalModelEvent> {
  const streamingRequest = { ...request, stream: true };
  const { provider } = validateModelRequest(streamingRequest, config);
  const maxRetries = provider.retry?.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES;
  const retryBaseDelay = provider.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  yield {
    type: "request_started",
    provider: provider.id,
    model: streamingRequest.model,
    providerBaseUrl: normalizeProviderBaseUrl(provider.url),
    metadata: streamingRequest.metadata,
  };

  let currentRequest = streamingRequest;
  const checkpoint = new StreamingCheckpointManager();

  if (provider.protocol === "google") {
    yield* streamGoogleProviderRequest({
      request: currentRequest,
      provider,
      maxRetries,
      retryBaseDelay,
      checkpoint,
      options,
    });
    return;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    const body = buildModelRequest(currentRequest, config);
    if (process.env.PILOTDECK_DUMP_REQUEST === "1") {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dumpPath = path.join(os.tmpdir(), `pilotdeck_request_${Date.now()}.json`);
      fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
      console.log(`[model-debug] Request dumped to ${dumpPath} (model=${currentRequest.model})`);
    }
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, true, options.fetch ?? fetch, options.signal);
    } catch (error) {
      if (attempt < maxRetries && isRetryableStreamError(error)) {
        await delay(retryBaseDelay * (attempt + 1));
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      const error = normalizeModelError(provider.id, provider.protocol, raw, response.status);
      if (error.retryAfterMs === undefined) {
        const headerMs = parseRetryAfterHeader(response.headers.get("retry-after"));
        if (headerMs !== undefined) {
          error.retryAfterMs = headerMs;
        }
      }
      yield { type: "error", error };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: normalizeModelError(provider.id, provider.protocol, new Error("Missing response body.")),
      };
      return;
    }

    const state = createStreamNormalizerState(provider.protocol);
    let streamCompleted = false;
    let sawCompletionSentinel = false;

    const streamIdleTimeoutMs = resolveStreamIdleTimeout(provider);

    try {
      for await (const sseEvent of readServerSentEvents(response.body, options.signal, streamIdleTimeoutMs)) {
        if (sseEvent.type === "done") {
          sawCompletionSentinel = true;
          continue;
        }
        for (const event of normalizeStreamEvent(provider.protocol, sseEvent.data, state)) {
          if (event.type === "message_end") {
            sawCompletionSentinel = true;
          }
          checkpoint.onEvent(event);
          yield event;
        }
      }
      if (!sawCompletionSentinel) {
        throw new IncompleteStreamError();
      }
      streamCompleted = true;
    } catch (error) {
      if (
        attempt < maxRetries &&
        isRetryableStreamError(error) &&
        checkpoint.hasSubstantialContent()
      ) {
        currentRequest = buildContinuationRequest(currentRequest, checkpoint.get().partialText);
        checkpoint.reset();
        await delay(retryBaseDelay * (attempt + 1), options.signal);
        continue;
      }

      if (isRetryableStreamError(error) && attempt < maxRetries) {
        await delay(retryBaseDelay * (attempt + 1), options.signal);
        continue;
      }

      throw error;
    }

    if (streamCompleted) {
      return;
    }
  }
}

async function sendGoogleCompleteRequest(
  provider: ProviderConfig,
  request: CanonicalModelRequest,
  options: ModelRuntimeOptions,
): Promise<unknown> {
  try {
    const body = withGoogleAbortSignal(buildModelRequest(request, {
      providers: { [provider.id]: provider },
    }) as Record<string, unknown>, options.signal);
    const client = (options.googleClientFactory ?? createGoogleClient)(provider);
    return await client.models.generateContent(body as unknown as GoogleRequestBody);
  } catch (error) {
    throwIfGoogleAbort(error, options.signal);
    throw toProviderError(provider, error);
  }
}

async function* streamGoogleProviderRequest(params: {
  request: CanonicalModelRequest & { stream: boolean };
  provider: ProviderConfig;
  maxRetries: number;
  retryBaseDelay: number;
  checkpoint: StreamingCheckpointManager;
  options: ModelRuntimeOptions;
}): AsyncIterable<CanonicalModelEvent> {
  let currentRequest = params.request;

  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    throwIfAborted(params.options.signal);
    try {
      const body = withGoogleAbortSignal(buildModelRequest(currentRequest, {
        providers: { [params.provider.id]: params.provider },
      }) as Record<string, unknown>, params.options.signal);
      if (process.env.PILOTDECK_DUMP_REQUEST === "1") {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const dumpPath = path.join(os.tmpdir(), `pilotdeck_request_${Date.now()}.json`);
        fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
        console.log(`[model-debug] Request dumped to ${dumpPath} (model=${currentRequest.model})`);
      }

      const client = (params.options.googleClientFactory ?? createGoogleClient)(params.provider);
      const stream = await client.models.generateContentStream(body as unknown as GoogleRequestBody);
      const state = createGoogleStreamState();
      let sawTerminalEvent = false;

      for await (const chunk of stream) {
        throwIfAborted(params.options.signal);
        for (const event of normalizeGoogleStreamEvent(chunk, state)) {
          if (event.type === "message_end" || event.type === "error") {
            sawTerminalEvent = true;
          }
          params.checkpoint.onEvent(event);
          yield event;
        }
      }

      if (!sawTerminalEvent && !state.ended) {
        yield { type: "message_end", finishReason: "unknown", raw: undefined };
      }
      return;
    } catch (error) {
      throwIfGoogleAbort(error, params.options.signal);
      const providerError = toProviderError(params.provider, error);
      if (
        attempt < params.maxRetries &&
        isRetryableGoogleStreamError(providerError, error) &&
        params.checkpoint.hasSubstantialContent()
      ) {
        currentRequest = buildContinuationRequest(currentRequest, params.checkpoint.get().partialText);
        params.checkpoint.reset();
        await delay(params.retryBaseDelay * (attempt + 1), params.options.signal);
        continue;
      }

      if (isRetryableGoogleStreamError(providerError, error) && attempt < params.maxRetries) {
        await delay(params.retryBaseDelay * (attempt + 1), params.options.signal);
        continue;
      }

      yield { type: "error", error: providerError.error };
      return;
    }
  }
}

function throwIfGoogleAbort(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
  if (isAbortError(error)) {
    throw error;
  }
}

function isRetryableGoogleStreamError(providerError: ModelProviderError, raw: unknown): boolean {
  return providerError.error.retryable || isRetryableStreamError(raw);
}

function withGoogleAbortSignal(body: Record<string, unknown>, signal: AbortSignal | undefined): Record<string, unknown> {
  if (!signal) {
    return body;
  }
  const config = body.config && typeof body.config === "object"
    ? { ...(body.config as Record<string, unknown>), abortSignal: signal }
    : { abortSignal: signal };
  return { ...body, config };
}

function toProviderError(provider: ProviderConfig, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  return new ModelProviderError(
    normalizeModelError(provider.id, provider.protocol, error, extractStatus(error)),
  );
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.code;
  if (typeof status === "number" && Number.isInteger(status)) {
    return status;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === "number" && Number.isInteger(responseStatus)) {
      return responseStatus;
    }
  }
  return undefined;
}

function isRetryableRequestError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ModelProviderError) {
    return error.error.retryable;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed") ||
      msg.includes("timeout") ||
      msg.includes("etimedout") ||
      msg.includes("epipe") ||
      msg.includes("econnrefused")
    );
  }
  return false;
}

function isRetryableStreamError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ModelProviderError) {
    return false;
  }
  if (error instanceof StreamIdleTimeoutError) {
    return true;
  }
  if (error instanceof IncompleteStreamError) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed") ||
      msg.includes("aborted") ||
      msg.includes("timeout") ||
      msg.includes("epipe") ||
      msg.includes("econnrefused")
    );
  }
  return false;
}

function buildContinuationRequest(
  original: CanonicalModelRequest & { stream: boolean },
  partialText: string,
): CanonicalModelRequest & { stream: boolean } {
  return {
    ...original,
    messages: [
      ...original.messages,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: partialText }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Continue from where you left off." }],
      },
    ],
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes

async function sendProviderRequest(
  provider: ProviderConfig,
  body: unknown,
  stream: boolean,
  transport: ModelTransport,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const detachAbort = signal ? forwardAbort(signal, controller) : undefined;
  const effectiveTimeoutMs = stream ? provider.timeoutMs : (provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const timeout = effectiveTimeoutMs
    ? setTimeout(() => controller.abort("request_timeout"), effectiveTimeoutMs)
    : undefined;

  const finalBody = provider.extraBody
    ? { ...(body as Record<string, unknown>), ...provider.extraBody }
    : body;

  try {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify(finalBody),
      signal: controller.signal,
    };
    return await transport(buildEndpoint(provider, stream), fetchOptions);
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    throw new ModelProviderError(normalizeModelError(provider.id, provider.protocol, error));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    detachAbort?.();
  }
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

function buildEndpoint(provider: ProviderConfig, _stream: boolean): string {
  if (provider.protocol === "anthropic") {
    return joinUrl(provider.url, "v1/messages");
  }

  return joinUrl(provider.url, "chat/completions");
}

function buildHeaders(provider: ProviderConfig): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers,
  };

  // Defensive trim: parseModelConfig already strips whitespace from
  // apiKey, but a programmatic caller could hand a ProviderConfig in
  // here that bypassed the parser. A stray space in the header value
  // (`Bearer  sk-...`) is silently rejected by most providers as
  // `invalid_token`, so guard at the wire boundary too.
  const apiKey = provider.apiKey.trim();
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  } else {
    headers.authorization = headers.authorization ?? `Bearer ${apiKey}`;
  }

  return headers;
}

async function safeReadJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Stream idle timeout: no data received for ${idleMs}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

class IncompleteStreamError extends Error {
  constructor() {
    super("Network stream ended before provider completion sentinel.");
    this.name = "IncompleteStreamError";
  }
}

type ServerSentEvent =
  | { type: "data"; data: unknown }
  | { type: "done" };

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncIterable<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const effectiveIdleMs = idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const cancelReader = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };

  if (signal?.aborted) {
    cancelReader();
    throw createAbortError(signal.reason);
  }
  signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const readResult = await readWithIdleTimeout(reader, effectiveIdleMs, signal);
      throwIfAborted(signal);
      const { value, done } = readResult;
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        yield* parseServerSentEventChunk(chunk);
      }
    }

    if (buffer.trim().length > 0) {
      for (const event of parseServerSentEventChunk(buffer)) {
        yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
}

function* parseServerSentEventChunk(chunk: string): Iterable<ServerSentEvent> {
  const dataLines = chunk
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  for (const data of dataLines) {
    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      yield { type: "done" };
      continue;
    }
    yield { type: "data", data: JSON.parse(data) };
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new StreamIdleTimeoutError(idleMs));
      }
    }, idleMs);
    if (typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(createAbortError(signal?.reason));
      }
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    reader.read().then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(result);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      },
    );
  });
}

function resolveStreamIdleTimeout(provider: ProviderConfig): number {
  const retry = provider.retry;
  if (retry && typeof retry.streamIdleTimeoutMs === "number" && retry.streamIdleTimeoutMs > 0) {
    return retry.streamIdleTimeoutMs;
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
