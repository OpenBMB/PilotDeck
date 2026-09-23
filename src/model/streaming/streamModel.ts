import { randomUUID } from "node:crypto";
import { sanitizeProviderBody } from "../request/sanitizeProviderBody.js";
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
import { isPrematureStreamCloseMessage, ModelProviderError, parseRetryAfterHeader } from "../protocol/errors.js";
import { parseModelResponse } from "../response/parseModelResponse.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "./normalizeStreamEvent.js";
import { createGoogleStreamState, normalizeGoogleStreamEvent } from "../providers/google/stream.js";
import { normalizeProviderBaseUrl } from "../normalizeProviderBaseUrl.js";
import { buildProviderChatEndpointCandidates, isExpectedProviderResponseShape } from "../providerEndpoint.js";
import { StreamingCheckpointManager } from "./StreamingCheckpoint.js";
import { buildLiteLLMContinuationRequest } from "./continuationRequest.js";
import { requestFingerprint } from "./requestFingerprint.js";
import { NetworkFetchError, networkFetch } from "../../network/fetch.js";
import { createNativeRetryPolicy, type RetryPolicy } from "../policy/index.js";
import type { InvocationLogContext, ModelInvocationLogSink } from "../../storage/invocationStorage.js";

export type ModelTransport = typeof fetch;

export type ModelRuntimeOptions = {
  fetch?: ModelTransport;
  googleClientFactory?: GoogleClientFactory;
  signal?: AbortSignal;
  streamTimeoutMs?: number;
  onRetryProgress?: (progress: ModelStreamRetryProgress) => void;
  retryPolicy?: RetryPolicy;
  /** Gateway-owned raw provider audit; staging is synchronous before send. */
  invocation?: {
    context: InvocationLogContext;
    sink: ModelInvocationLogSink;
  };
};

export type ModelStreamRetryProgress = {
  reason: "network_error" | "server_error" | "continuation";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  provider: string;
  model: string;
};

export const LITELLM_DEFAULT_MAX_RETRIES = 2;
export const LITELLM_DEFAULT_REQUEST_TIMEOUT_MS = 6_000_000;
export const LITELLM_COMPLETION_HTTP_FALLBACK_MS = 600_000;
export const LITELLM_REPEATED_STREAMING_CHUNK_LIMIT = 100;
export const LITELLM_INITIAL_RETRY_DELAY_MS = 500;
export const LITELLM_MAX_RETRY_DELAY_MS = 8_000;
export const LITELLM_RETRY_JITTER = 0.75;
export const LITELLM_HTTP_CONNECTOR_LIMIT = 1000;
export const LITELLM_HTTP_CONNECTOR_LIMIT_PER_HOST = 500;
export const LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS = 120_000;
export const LITELLM_HTTP_TTL_DNS_CACHE_MS = 300_000;
export const LITELLM_HTTP_SO_KEEPALIVE = false;
export const LITELLM_HTTP_TCP_KEEPIDLE_SECONDS = 60;
export const LITELLM_HTTP_TCP_KEEPINTVL_SECONDS = 30;
export const LITELLM_HTTP_TCP_KEEPCNT = 5;
export const LITELLM_STREAM_MAX_DURATION_MS: number | undefined = readOptionalPositiveEnvMs(
  "LITELLM_MAX_STREAMING_DURATION_SECONDS",
  1000,
);

const DEFAULT_REQUEST_MAX_RETRIES = LITELLM_DEFAULT_MAX_RETRIES;

export async function complete(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
) {
  const nonStreamingRequest = { ...request, stream: false };
  const { provider } = validateModelRequest(nonStreamingRequest, config);
  // `complete()` historically used a linear request retry delay. Streaming
  // keeps the shared jittered policy because continuation/reconnect retries
  // intentionally retain that behavior.
  const retryPolicy = options.retryPolicy ?? createNativeRetryPolicy({
    defaultMaxRetries: DEFAULT_REQUEST_MAX_RETRIES,
    defaultJitter: 0,
  });
  const maxRetries = retryPolicy.decide({ provider, kind: "request", attempt: 0 }).maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    if (provider.protocol === "google") {
      const body = buildModelRequest(nonStreamingRequest, { providers: { [provider.id]: provider } });
      const invocation = beginInvocation(options, provider, nonStreamingRequest.model, false, body, attempt + 1);
      try {
        const raw = await sendGoogleCompleteRequest(
          provider,
          nonStreamingRequest,
          options,
        );
        finishInvocation(invocation, options, "success", JSON.stringify(raw), undefined, undefined, true);
        return parseGoogleResponse(raw, provider.id);
      } catch (error) {
        finishInvocation(invocation, options, "transport_error", undefined, undefined, error);
        if (attempt < maxRetries && isRetryableRequestError(error)) {
          const { delayMs } = retryPolicy.decide({ provider, kind: "request", attempt });
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
    const invocation = beginInvocation(options, provider, nonStreamingRequest.model, false, body, attempt + 1);
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, false, options.fetch ?? fetch, options.signal);
    } catch (error) {
      finishInvocation(invocation, options, "transport_error", undefined, undefined, error);
      if (attempt < maxRetries && isRetryableRequestError(error)) {
        const { delayMs } = retryPolicy.decide({ provider, kind: "request", attempt });
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
      const rawText = await response.text();
      const raw = parseRawJson(rawText);
      finishInvocation(invocation, options, "provider_error", rawText, response.status, undefined, false);
      throw new ModelProviderError(
        normalizeModelError(provider.id, provider.protocol, raw, response.status),
      );
    }

    const rawText = await response.text();
    const raw = parseRawJson(rawText);
    finishInvocation(invocation, options, "success", rawText, response.status, undefined, true);
    return parseModelResponse(provider.protocol, raw, provider.id);
  }

  throw new Error("complete() exhausted all retry attempts without a result.");
}

const DEFAULT_STREAM_MAX_RETRIES = LITELLM_DEFAULT_MAX_RETRIES;

export async function* streamModel(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): AsyncIterable<CanonicalModelEvent> {
  const streamingRequest = { ...request, stream: true };
  const { provider } = validateModelRequest(streamingRequest, config);
  const retryPolicy = options.retryPolicy ?? createNativeRetryPolicy({ defaultMaxRetries: DEFAULT_STREAM_MAX_RETRIES });
  const maxRetries = retryPolicy.decide({ provider, kind: "stream", attempt: 0 }).maxRetries;

  let currentRequest = streamingRequest;
  const checkpoint = new StreamingCheckpointManager();

  if (provider.protocol === "google") {
    yield* streamGoogleProviderRequest({
      request: currentRequest,
      provider,
      maxRetries,
      retryPolicy,
      checkpoint,
      options,
    });
    return;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    yield {
      type: "request_started",
      provider: provider.id,
      model: currentRequest.model,
      providerBaseUrl: normalizeProviderBaseUrl(provider.url),
      requestFingerprint: requestFingerprint(currentRequest),
      metadata: currentRequest.metadata,
    };
    const body = buildModelRequest(currentRequest, config);
    const invocation = beginInvocation(options, provider, currentRequest.model, true, body, attempt + 1);
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
      response = await sendProviderRequest(provider, body, true, options.fetch ?? fetch, options.signal, options);
    } catch (error) {
      finishInvocation(invocation, options, "transport_error", undefined, undefined, error);
      if (attempt < maxRetries && isRetryableStreamError(error)) {
        const delayMs = retryPolicy.decide({ provider, kind: "stream", attempt }).delayMs;
        emitModelRetryProgress(options, "network_error", attempt, maxRetries, delayMs, provider, currentRequest.model);
        await delay(delayMs, options.signal);
        continue;
      }
      if (isRetryableStreamError(error) && checkpoint.interruption().phase !== "empty") {
        yield {
          type: "error",
          error: streamInterruptionError(provider, error, checkpoint),
        };
        return;
      }
      throw error;
    }

    if (!response.ok) {
      const rawText = await response.text();
      const raw = parseRawJson(rawText);
      finishInvocation(invocation, options, "provider_error", rawText, response.status, undefined, false);
      const error = normalizeModelError(provider.id, provider.protocol, raw, response.status);
      if (error.retryAfterMs === undefined) {
        const headerMs = parseRetryAfterHeader(response.headers.get("retry-after"));
        if (headerMs !== undefined) {
          error.retryAfterMs = headerMs;
        }
      }
      if (error.retryable && attempt < maxRetries) {
        const delayMs = retryPolicy.decide({ provider, kind: "stream", attempt, retryAfterMs: error.retryAfterMs }).delayMs;
        emitModelRetryProgress(options, retryReasonForError(error.code), attempt, maxRetries, delayMs, provider, currentRequest.model);
        await delay(delayMs, options.signal);
        continue;
      }
      if (error.retryable && checkpoint.interruption().phase !== "empty") {
        yield {
          type: "error",
          error: streamInterruptionError(provider, new ModelProviderError(error), checkpoint),
        };
        return;
      }
      yield { type: "error", error };
      return;
    }

    if (!response.body) {
      finishInvocation(invocation, options, "incomplete", undefined, response.status, undefined, false);
      yield {
        type: "error",
        error: normalizeModelError(provider.id, provider.protocol, new Error("Missing response body.")),
      };
      return;
    }

    const state = createStreamNormalizerState(provider.protocol);
    let streamCompleted = false;
    let sawCompletionSentinel = false;

    const streamIdleTimeoutMs = resolveStreamIdleTimeout(provider, options);
    const streamGuard = createStreamGuard(provider);
    const rawResponseChunks: Buffer[] = [];
    let rawResponseBytes = 0;
    let decodedRawResponse: string | undefined;
    const getRawResponse = (): string => {
      decodedRawResponse ??= Buffer.concat(rawResponseChunks, rawResponseBytes).toString("utf8");
      return decodedRawResponse;
    };

    try {
      for await (const sseEvent of readServerSentEvents(response.body, options.signal, streamIdleTimeoutMs, (chunk) => {
        const copy = Buffer.from(chunk);
        rawResponseChunks.push(copy);
        rawResponseBytes += copy.byteLength;
      })) {
        streamGuard.checkDuration();
        if (sseEvent.type === "done") {
          sawCompletionSentinel = true;
          continue;
        }
        for (const event of normalizeStreamEvent(provider.protocol, sseEvent.data, state)) {
          if (event.type === "message_end") {
            sawCompletionSentinel = true;
          }
          if (event.type === "error") {
            throw new ModelProviderError(event.error);
          }
          streamGuard.observe(event);
          checkpoint.onEvent(event);
          yield event;
        }
      }
      streamGuard.checkDuration();
      if (!sawCompletionSentinel) {
        throw new IncompleteStreamError();
      }
      streamCompleted = true;
      finishInvocation(invocation, options, "success", getRawResponse(), response.status, undefined, true, rawResponseBytes);
    } catch (error) {
      if (
        attempt < maxRetries &&
        isRetryableStreamError(error) &&
        checkpoint.canContinueText()
      ) {
        finishInvocation(invocation, options, "incomplete", getRawResponse(), response.status, error, false, rawResponseBytes);
        currentRequest = buildLiteLLMContinuationRequest(currentRequest, checkpoint.get().partialText);
        const delayMs = retryPolicy.decide({ provider, kind: "stream", attempt, retryAfterMs: retryAfterMsForError(error) }).delayMs;
        emitModelRetryProgress(options, "continuation", attempt, maxRetries, delayMs, provider, currentRequest.model);
        await delay(delayMs, options.signal);
        continue;
      }

      if (
        isRetryableStreamError(error) &&
        attempt < maxRetries &&
        checkpoint.interruption().phase === "empty"
      ) {
        finishInvocation(invocation, options, "incomplete", getRawResponse(), response.status, error, false, rawResponseBytes);
        const delayMs = retryPolicy.decide({ provider, kind: "stream", attempt, retryAfterMs: retryAfterMsForError(error) }).delayMs;
        emitModelRetryProgress(options, retryReasonForThrownError(error), attempt, maxRetries, delayMs, provider, currentRequest.model);
        await delay(delayMs, options.signal);
        continue;
      }

      if (isRetryableStreamError(error)) {
        finishInvocation(invocation, options, "incomplete", getRawResponse(), response.status, error, false, rawResponseBytes);
        yield {
          type: "error",
          error: streamInterruptionError(provider, error, checkpoint),
        };
        return;
      }
      finishInvocation(invocation, options, "transport_error", getRawResponse(), response.status, error, false, rawResponseBytes);
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
  retryPolicy: RetryPolicy;
  checkpoint: StreamingCheckpointManager;
  options: ModelRuntimeOptions;
}): AsyncIterable<CanonicalModelEvent> {
  let currentRequest = params.request;

  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    throwIfAborted(params.options.signal);
    yield {
      type: "request_started",
      provider: params.provider.id,
      model: currentRequest.model,
      providerBaseUrl: normalizeProviderBaseUrl(params.provider.url),
      requestFingerprint: requestFingerprint(currentRequest),
      metadata: currentRequest.metadata,
    };
    const streamAbort = new AbortController();
    const detachAbort = params.options.signal ? forwardAbort(params.options.signal, streamAbort) : undefined;
    let invocation: InvocationAttempt | undefined;
    try {
      const body = withGoogleAbortSignal(buildModelRequest(currentRequest, {
        providers: { [params.provider.id]: params.provider },
      }) as Record<string, unknown>, streamAbort.signal);
      invocation = beginInvocation(params.options, params.provider, currentRequest.model, true, body, attempt + 1);
      if (process.env.PILOTDECK_DUMP_REQUEST === "1") {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const dumpPath = path.join(os.tmpdir(), `pilotdeck_request_${Date.now()}.json`);
        fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
        console.log(`[model-debug] Request dumped to ${dumpPath} (model=${currentRequest.model})`);
      }

      // The Google SDK applies HttpOptions.timeout to the entire HTTP request.
      // Streaming uses a per-read idle watchdog below, so do not give the SDK
      // either the idle timeout or the provider's request timeout here.
      const client = (params.options.googleClientFactory ?? createGoogleClient)({
        ...params.provider,
        timeoutMs: undefined,
      });
      const streamIdleTimeoutMs = resolveStreamIdleTimeout(params.provider, params.options);
      const abortForIdleTimeout = (error: StreamIdleTimeoutError) => streamAbort.abort(error);
      const stream = await withIdleTimeout(
        () => client.models.generateContentStream(body as unknown as GoogleRequestBody),
        streamIdleTimeoutMs,
        params.options.signal,
        abortForIdleTimeout,
      );
      const state = createGoogleStreamState();
      let sawTerminalEvent = false;
      const streamGuard = createStreamGuard(params.provider);

      while (true) {
        const { value: chunk, done } = await withIdleTimeout(
          () => stream.next(),
          streamIdleTimeoutMs,
          params.options.signal,
          abortForIdleTimeout,
        );
        if (done) {
          break;
        }
        throwIfAborted(params.options.signal);
        streamGuard.checkDuration();
        for (const event of normalizeGoogleStreamEvent(chunk, state)) {
          const terminalEvent = event.type === "message_end" || event.type === "error";
          if (terminalEvent) {
            sawTerminalEvent = true;
          }
          if (event.type === "error") {
            throw new ModelProviderError(event.error);
          }
          streamGuard.observe(event);
            params.checkpoint.onEvent(event);
            yield event;
            if (terminalEvent) {
              void stream.return(undefined).catch(() => undefined);
              finishInvocation(invocation, params.options, "success", undefined, undefined, undefined, true);
              return;
            }
        }
      }
      streamGuard.checkDuration();

      if (!sawTerminalEvent && !state.ended) {
        throw new IncompleteStreamError();
      }
      finishInvocation(invocation, params.options, "success", undefined, undefined, undefined, true);
      return;
    } catch (error) {
      throwIfGoogleAbort(error, params.options.signal);
      const providerError = toProviderError(params.provider, error);
      finishInvocation(invocation, params.options, "incomplete", undefined, undefined, error, false);
      const retryable = isRetryableGoogleStreamError(providerError, error);
      if (
        attempt < params.maxRetries &&
        retryable &&
        params.checkpoint.canContinueText()
      ) {
        currentRequest = buildLiteLLMContinuationRequest(currentRequest, params.checkpoint.get().partialText);
        const delayMs = params.retryPolicy.decide({ provider: params.provider, kind: "stream", attempt }).delayMs;
        emitModelRetryProgress(params.options, "continuation", attempt, params.maxRetries, delayMs, params.provider, currentRequest.model);
        await delay(delayMs, params.options.signal);
        continue;
      }

      if (
        retryable &&
        attempt < params.maxRetries &&
        params.checkpoint.interruption().phase === "empty"
      ) {
        const delayMs = params.retryPolicy.decide({ provider: params.provider, kind: "stream", attempt }).delayMs;
        emitModelRetryProgress(params.options, "network_error", attempt, params.maxRetries, delayMs, params.provider, currentRequest.model);
        await delay(delayMs, params.options.signal);
        continue;
      }

      yield {
        type: "error",
        error: retryable
          ? streamInterruptionError(params.provider, providerError, params.checkpoint)
          : providerError.error,
      };
      return;
    } finally {
      detachAbort?.();
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

function streamInterruptionError(
  provider: ProviderConfig,
  error: unknown,
  checkpoint: StreamingCheckpointManager,
): import("../protocol/errors.js").CanonicalModelError {
  const providerError = toProviderError(provider, error).error;
  return {
    ...providerError,
    streamInterruption: checkpoint.interruption(),
  };
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
    return error.error.retryable || isPrematureStreamCloseMessage(error.error.message);
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
      msg.includes("econnrefused") ||
      isPrematureStreamCloseMessage(error.message)
    );
  }
  return false;
}

function isRetryableStreamError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ModelProviderError) {
    return error.error.retryable || isPrematureStreamCloseMessage(error.error.message);
  }
  if (error instanceof StreamIdleTimeoutError) {
    return true;
  }
  if (error instanceof IncompleteStreamError) {
    return true;
  }
  if (error instanceof MaxStreamingDurationError) {
    return true;
  }
  if (error instanceof RepeatedStreamingChunkError) {
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
      msg.includes("econnrefused") ||
      isPrematureStreamCloseMessage(error.message)
    );
  }
  return false;
}


function retryAfterMsForError(error: unknown): number | undefined {
  return error instanceof ModelProviderError ? error.error.retryAfterMs : undefined;
}

function retryReasonForThrownError(error: unknown): ModelStreamRetryProgress["reason"] {
  if (error instanceof ModelProviderError) {
    return retryReasonForError(error.error.code);
  }
  return "network_error";
}

function retryReasonForError(code: string): ModelStreamRetryProgress["reason"] {
  return code === "server_error" ? "server_error" : "network_error";
}

function emitModelRetryProgress(
  options: ModelRuntimeOptions,
  reason: ModelStreamRetryProgress["reason"],
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  provider: ProviderConfig,
  model: string,
): void {
  options.onRetryProgress?.({
    reason,
    attempt: attempt + 1,
    maxAttempts,
    delayMs: Math.round(delayMs),
    provider: provider.id,
    model,
  });
}

type StreamGuard = {
  checkDuration: () => void;
  observe: (event: CanonicalModelEvent) => void;
};

function createStreamGuard(provider: ProviderConfig): StreamGuard {
  const startedAt = Date.now();
  const maxDurationMs = provider.retry?.maxStreamingDurationMs ?? LITELLM_STREAM_MAX_DURATION_MS;
  const repeatedChunkLimit = provider.retry?.repeatedChunkLimit ?? LITELLM_REPEATED_STREAMING_CHUNK_LIMIT;
  let lastText: string | undefined;
  let repeatedCount = 1;

  return {
    checkDuration() {
      if (maxDurationMs !== undefined && Date.now() - startedAt > maxDurationMs) {
        throw new MaxStreamingDurationError(maxDurationMs);
      }
    },
    observe(event) {
      this.checkDuration();
      if (event.type !== "text_delta" || typeof event.text !== "string" || event.text.length <= 2) {
        repeatedCount = 1;
        lastText = undefined;
        return;
      }
      if (event.text === lastText) {
        repeatedCount += 1;
      } else {
        lastText = event.text;
        repeatedCount = 1;
      }
      if (repeatedCount >= repeatedChunkLimit) {
        throw new RepeatedStreamingChunkError(event.text);
      }
    },
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

const DEFAULT_REQUEST_TIMEOUT_MS = LITELLM_COMPLETION_HTTP_FALLBACK_MS;

async function sendProviderRequest(
  provider: ProviderConfig,
  body: unknown,
  stream: boolean,
  transport: ModelTransport,
  signal?: AbortSignal,
  options?: ModelRuntimeOptions,
): Promise<Response> {
  const controller = new AbortController();
  const detachAbort = signal ? forwardAbort(signal, controller) : undefined;
  const effectiveTimeoutMs = stream
    ? resolveStreamIdleTimeout(provider, options)
    : provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timeout = effectiveTimeoutMs
    ? setTimeout(() => controller.abort(new NetworkFetchError(
      "network_timeout",
      stream
        ? `Stream idle timeout: no data received for ${effectiveTimeoutMs}ms`
        : `Model request timed out after ${effectiveTimeoutMs}ms.`,
    )), effectiveTimeoutMs)
    : undefined;

  const finalBody = sanitizeProviderBody({ ...(body as Record<string, unknown>), ...provider.extraBody });

  try {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: buildProviderHeaders(provider, finalBody),
      body: JSON.stringify(finalBody),
      signal: controller.signal,
    };
    return await sendWithEndpointFallback(provider, stream, transport, fetchOptions, effectiveTimeoutMs);
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

async function sendWithEndpointFallback(
  provider: ProviderConfig,
  stream: boolean,
  transport: ModelTransport,
  fetchOptions: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const endpoints = buildProviderChatEndpointCandidates({ protocol: provider.protocol, baseUrl: provider.url });
  let lastResponse: Response | undefined;
  for (const endpoint of endpoints) {
    const response = await networkFetch(endpoint, fetchOptions, {
      signal: fetchOptions.signal instanceof AbortSignal ? fetchOptions.signal : undefined,
      fetchImpl: transport === fetch ? undefined : transport,
      timeoutMs,
      retry: { maxRetries: 0, retryOnPost: true },
    });
    if (await shouldUseEndpointResponse(provider, response, stream, endpoints.length)) {
      return response;
    }
    lastResponse = response;
  }
  return lastResponse as Response;
}

function isEndpointFallbackStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 405;
}

async function shouldUseEndpointResponse(
  provider: ProviderConfig,
  response: Response,
  stream: boolean,
  endpointCount: number,
): Promise<boolean> {
  if (!response.ok) return endpointCount === 1 || !isEndpointFallbackStatus(response.status);
  if (stream || endpointCount === 1) return true;
  try {
    const body = await response.clone().json();
    return isExpectedProviderResponseShape(provider.protocol, body);
  } catch {
    return false;
  }
}

export function buildProviderHeaders(provider: ProviderConfig, body?: unknown): HeadersInit {
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
    if (provider.speedMapping === "anthropic_speed" && isFastAnthropicRequest(body)) {
      appendAnthropicBeta(headers, "fast-mode-2026-02-01");
    }
  } else {
    headers.authorization = headers.authorization ?? `Bearer ${apiKey}`;
  }

  return headers;
}

function isFastAnthropicRequest(body: unknown): boolean {
  return typeof body === "object" && body !== null
    && (body as { speed?: unknown }).speed === "fast";
}

function appendAnthropicBeta(headers: Record<string, string>, beta: string): void {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "anthropic-beta");
  const key = existingKey ?? "anthropic-beta";
  const values = (headers[key] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(beta)) values.push(beta);
  headers[key] = values.join(", ");
}

function parseRawJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type InvocationAttempt = {
  requestLogId: string;
  requestId: string;
  startedAt: string;
  requestBody: string;
  attempt: number;
  provider: ProviderConfig;
  model: string;
  stream: boolean;
  finished: boolean;
};

function beginInvocation(
  options: ModelRuntimeOptions,
  provider: ProviderConfig,
  model: string,
  stream: boolean,
  body: unknown,
  attempt: number,
): InvocationAttempt | undefined {
  const invocation = options.invocation;
  if (!invocation) return undefined;
  const requestBody = JSON.stringify(provider.extraBody ? { ...(body as Record<string, unknown>), ...provider.extraBody } : body);
  const startedAt = new Date().toISOString();
  const state: InvocationAttempt = {
    requestLogId: randomUUID(),
    requestId: randomUUID(),
    startedAt,
    requestBody,
    attempt,
    provider,
    model,
    stream,
    finished: false,
  };
  // This call is deliberately synchronous: a storage failure must prevent
  // the provider request from being sent.
  invocation.sink.stage({
    ...invocation.context,
    requestLogId: state.requestLogId,
    requestId: state.requestId,
    attempt,
    provider: provider.id,
    protocol: provider.protocol,
    model,
    stream,
    requestBody,
    requestBytes: Buffer.byteLength(requestBody),
    outcome: "success",
    responseComplete: false,
    startedAt,
    completedAt: startedAt,
  });
  return state;
}

function finishInvocation(
  state: InvocationAttempt | undefined,
  options: ModelRuntimeOptions,
  outcome: "success" | "provider_error" | "transport_error" | "aborted" | "timeout" | "incomplete",
  responseBody?: string,
  httpStatus?: number,
  error?: unknown,
  responseComplete = false,
  responseBytes?: number,
): void {
  if (!state || !options.invocation || state.finished) return;
  state.finished = true;
  const normalizedOutcome = options.signal?.aborted
    ? "aborted"
    : error instanceof StreamIdleTimeoutError
      ? "timeout"
      : outcome;
  const record = {
    ...options.invocation.context,
    requestLogId: state.requestLogId,
    requestId: state.requestId,
    attempt: state.attempt,
    provider: state.provider.id,
    protocol: state.provider.protocol,
    model: state.model,
    stream: state.stream,
    requestBody: state.requestBody,
    responseBody,
    requestBytes: Buffer.byteLength(state.requestBody),
    responseBytes: responseBody === undefined ? undefined : responseBytes ?? Buffer.byteLength(responseBody),
    httpStatus,
    outcome: normalizedOutcome,
    responseComplete,
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
  };
  void options.invocation.sink.append(record).catch((appendError: unknown) => {
    // The provider outcome is already fixed, but losing its audit terminal is
    // operationally significant. Report only correlation fields, never bodies.
    const context = options.invocation?.context;
    console.error(
      `[PilotDeck] failed to persist model invocation audit run=${context?.runId ?? "unknown"} ` +
      `turn=${context?.turnId ?? "unknown"} requestLogId=${record.requestLogId} attempt=${record.attempt}`,
      appendError instanceof Error ? appendError.message : appendError,
    );
  });
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = LITELLM_COMPLETION_HTTP_FALLBACK_MS;

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

class MaxStreamingDurationError extends Error {
  constructor(durationMs: number) {
    super(`Stream exceeded max streaming duration of ${durationMs}ms`);
    this.name = "MaxStreamingDurationError";
  }
}

class RepeatedStreamingChunkError extends Error {
  constructor(chunk: string) {
    super(`The model is repeating the same chunk = ${chunk}.`);
    this.name = "RepeatedStreamingChunkError";
  }
}

type ServerSentEvent =
  | { type: "data"; data: unknown }
  | { type: "done" };

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
  onChunk?: (chunk: Uint8Array) => void,
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

      onChunk?.(value);

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
    await reader.cancel().catch(() => undefined);
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
  return withIdleTimeout(() => reader.read(), idleMs, signal);
}

function withIdleTimeout<T>(
  operation: () => Promise<T>,
  idleMs: number,
  signal?: AbortSignal,
  onIdleTimeout?: (error: StreamIdleTimeoutError) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const error = new StreamIdleTimeoutError(idleMs);
        onIdleTimeout?.(error);
        reject(error);
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
    operation().then(
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

export function resolveStreamIdleTimeout(provider: ProviderConfig, options?: ModelRuntimeOptions): number {
  if (typeof options?.streamTimeoutMs === "number" && options.streamTimeoutMs > 0) {
    return options.streamTimeoutMs;
  }
  const retry = provider.retry;
  if (retry && typeof retry.streamIdleTimeoutMs === "number" && retry.streamIdleTimeoutMs > 0) {
    return retry.streamIdleTimeoutMs;
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function readOptionalPositiveEnvMs(name: string, multiplier: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value * multiplier;
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
