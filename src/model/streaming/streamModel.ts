import { normalizeModelError } from "../errors/normalizeModelError.js";
import { buildModelRequest } from "../request/buildModelRequest.js";
import { validateModelRequest } from "../request/validateModelRequest.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelConfig,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";
import { ModelProviderError } from "../protocol/errors.js";
import { parseModelResponse } from "../response/parseModelResponse.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "./normalizeStreamEvent.js";
import { StreamingCheckpointManager } from "./StreamingCheckpoint.js";

export type ModelTransport = typeof fetch;

export type ModelRuntimeOptions = {
  fetch?: ModelTransport;
  signal?: AbortSignal;
};

export async function complete(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
) {
  const nonStreamingRequest = { ...request, stream: false };
  const { provider } = validateModelRequest(nonStreamingRequest, config);
  const body = buildModelRequest(nonStreamingRequest, config);
  const response = await sendProviderRequest(provider, body, false, options.fetch ?? fetch, options.signal);

  if (!response.ok) {
    const raw = await safeReadJson(response);
    throw new ModelProviderError(
      normalizeModelError(provider.id, provider.protocol, raw, response.status),
    );
  }

  const raw = await response.json();
  return parseModelResponse(provider.protocol, raw, provider.id);
}

const MAX_STREAM_RETRIES = 2;

export async function* streamModel(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): AsyncIterable<CanonicalModelEvent> {
  const streamingRequest = { ...request, stream: true };
  const { provider } = validateModelRequest(streamingRequest, config);

  yield {
    type: "request_started",
    provider: provider.id,
    model: streamingRequest.model,
    metadata: streamingRequest.metadata,
  };

  let currentRequest = streamingRequest;
  const checkpoint = new StreamingCheckpointManager();

  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    throwIfAborted(options.signal);
    const body = buildModelRequest(currentRequest, config);
    if (process.env.PILOTDECK_DUMP_REQUEST === "1") {
      const fs = await import("node:fs");
      const dumpPath = `/tmp/pilotdeck_request_${Date.now()}.json`;
      fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
      console.log(`[model-debug] Request dumped to ${dumpPath} (model=${currentRequest.model})`);
    }
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, true, options.fetch ?? fetch, options.signal);
    } catch (error) {
      if (attempt < MAX_STREAM_RETRIES && isRetryableStreamError(error)) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      yield {
        type: "error",
        error: normalizeModelError(provider.id, provider.protocol, raw, response.status),
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: normalizeModelError(provider.id, provider.protocol, new Error("Missing response body.")),
      };
      return;
    }

    const state = createStreamNormalizerState();
    let streamCompleted = false;

    try {
      for await (const rawEvent of readServerSentEvents(response.body, options.signal)) {
        for (const event of normalizeStreamEvent(provider.protocol, rawEvent, state)) {
          checkpoint.onEvent(event);
          yield event;
        }
      }
      streamCompleted = true;
    } catch (error) {
      if (
        attempt < MAX_STREAM_RETRIES &&
        isRetryableStreamError(error) &&
        checkpoint.hasSubstantialContent()
      ) {
        currentRequest = buildContinuationRequest(currentRequest, checkpoint.get().partialText);
        checkpoint.reset();
        await delay(1000 * (attempt + 1), options.signal);
        continue;
      }

      if (isRetryableStreamError(error) && attempt < MAX_STREAM_RETRIES) {
        await delay(1000 * (attempt + 1), options.signal);
        continue;
      }

      throw error;
    }

    if (streamCompleted) {
      return;
    }
  }
}

function isRetryableStreamError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ModelProviderError) {
    return false;
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

async function sendProviderRequest(
  provider: ProviderConfig,
  body: unknown,
  stream: boolean,
  transport: ModelTransport,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const detachAbort = signal ? forwardAbort(signal, controller) : undefined;
  const timeout = provider.timeoutMs
    ? setTimeout(() => controller.abort(), provider.timeoutMs)
    : undefined;

  const finalBody = provider.extraBody
    ? { ...(body as Record<string, unknown>), ...provider.extraBody }
    : body;

  try {
    return await transport(buildEndpoint(provider, stream), {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify(finalBody),
      signal: controller.signal,
    });
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

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const dataLines = chunk
          .split(/\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim());

        for (const data of dataLines) {
          if (!data || data === "[DONE]") {
            continue;
          }
          yield JSON.parse(data);
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
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
