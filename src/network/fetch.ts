import { fetch as undiciFetch } from "undici";

export type NetworkErrorCode =
  | "network_timeout"
  | "network_dns_error"
  | "network_connection_reset"
  | "network_connection_refused"
  | "network_tls_error"
  | "network_proxy_error"
  | "network_rate_limited"
  | "network_server_error"
  | "network_abort"
  | "network_fetch_failed";

export class NetworkFetchError extends Error {
  readonly name = "NetworkFetchError";

  constructor(
    readonly code: NetworkErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type NetworkRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnPost?: boolean;
  retryStatuses?: readonly number[];
};

export type NetworkFetchOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: NetworkRetryOptions;
  fetchImpl?: typeof fetch;
};

export type NetworkJsonOptions = NetworkFetchOptions & {
  expectedStatuses?: readonly number[];
};

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function networkFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: NetworkFetchOptions = {},
): Promise<Response> {
  const retry = options.retry ?? {};
  const maxRetries = Math.max(0, retry.maxRetries ?? 0);
  const method = resolveMethod(input, init);
  const canRetryMethod = SAFE_METHODS.has(method) || retry.retryOnPost === true;
  const parentSignal = options.signal ?? (init.signal instanceof AbortSignal ? init.signal : undefined);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const detachAbort = parentSignal ? forwardAbort(parentSignal, controller) : undefined;
    const timeout = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => controller.abort(new NetworkFetchError("network_timeout", `Network request timed out after ${options.timeoutMs}ms.`)), options.timeoutMs)
      : undefined;

    try {
      const response = await performFetch(input, {
        ...init,
        signal: controller.signal,
      }, options.fetchImpl);

      if (
        canRetryMethod &&
        attempt < maxRetries &&
        shouldRetryStatus(response.status, retry.retryStatuses)
      ) {
        await response.body?.cancel().catch(() => undefined);
        await delay(resolveRetryDelay(attempt, retry, response.headers.get("retry-after")), parentSignal);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      const normalized = normalizeNetworkError(error, controller.signal, parentSignal);
      if (!canRetryMethod || attempt >= maxRetries || !isRetryableNetworkCode(normalized.code)) {
        throw normalized;
      }
      await delay(resolveRetryDelay(attempt, retry), parentSignal);
    } finally {
      if (timeout) clearTimeout(timeout);
      detachAbort?.();
    }
  }

  throw normalizeNetworkError(lastError);
}

export async function networkFetchJson<T = unknown>(
  input: string | URL | Request,
  init: RequestInit = {},
  options: NetworkJsonOptions = {},
): Promise<{ response: Response; json: T; text: string }> {
  const response = await networkFetch(input, init, options);
  const text = await response.text();
  const okStatus = options.expectedStatuses?.includes(response.status) ?? response.ok;
  if (!okStatus) {
    throw new NetworkFetchError(
      response.status === 429 ? "network_rate_limited" : response.status >= 500 ? "network_server_error" : "network_fetch_failed",
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
      { status: response.status, statusText: response.statusText, body: text },
    );
  }
  try {
    return { response, json: JSON.parse(text) as T, text };
  } catch (error) {
    throw new NetworkFetchError("network_fetch_failed", `Non-JSON response from ${String(input)}: ${text.slice(0, 500)}`, error);
  }
}

export function networkPostJson<T = unknown>(
  input: string | URL | Request,
  body: unknown,
  init: RequestInit = {},
  options: NetworkJsonOptions = {},
): Promise<{ response: Response; json: T; text: string }> {
  return networkFetchJson<T>(input, {
    ...init,
    method: "POST",
    headers: withJsonContentType(init.headers),
    body: JSON.stringify(body),
  }, {
    ...options,
    retry: { retryOnPost: true, ...options.retry },
  });
}

export function normalizeNetworkError(
  error: unknown,
  localSignal?: AbortSignal,
  parentSignal?: AbortSignal,
): NetworkFetchError {
  if (error instanceof NetworkFetchError) return error;
  if (parentSignal?.aborted) {
    if (parentSignal.reason instanceof NetworkFetchError) return parentSignal.reason;
    return new NetworkFetchError("network_abort", "Network request aborted by parent signal.", parentSignal.reason);
  }
  if (localSignal?.aborted) {
    const reason = localSignal.reason;
    if (reason instanceof NetworkFetchError) return reason;
    return new NetworkFetchError("network_timeout", "Network request timed out.", reason);
  }

  const message = error instanceof Error ? error.message : String(error ?? "Network request failed.");
  const code = readErrorCode(error);
  const combined = `${code ?? ""} ${message}`.toLowerCase();

  if (combined.includes("enotfound") || combined.includes("eai_again") || combined.includes("dns")) {
    return new NetworkFetchError("network_dns_error", message, error);
  }
  if (combined.includes("econnreset") || combined.includes("socket hang up") || combined.includes("terminated")) {
    return new NetworkFetchError("network_connection_reset", message, error);
  }
  if (combined.includes("econnrefused")) {
    return new NetworkFetchError("network_connection_refused", message, error);
  }
  if (combined.includes("etimedout") || combined.includes("timeout")) {
    return new NetworkFetchError("network_timeout", message, error);
  }
  if (combined.includes("certificate") || combined.includes("tls") || combined.includes("ssl")) {
    return new NetworkFetchError("network_tls_error", message, error);
  }
  if (combined.includes("proxy")) {
    return new NetworkFetchError("network_proxy_error", message, error);
  }
  if (combined.includes("abort")) {
    return new NetworkFetchError("network_abort", message, error);
  }
  return new NetworkFetchError("network_fetch_failed", message, error);
}

export function isRetryableNetworkCode(code: NetworkErrorCode): boolean {
  return code !== "network_abort" && code !== "network_tls_error";
}

export function jitteredBackoff(attempt: number, retry: NetworkRetryOptions = {}, retryAfterHeader?: string | null): number {
  return resolveRetryDelay(attempt, retry, retryAfterHeader);
}

function performFetch(input: string | URL | Request, init: RequestInit, fetchImpl?: typeof fetch): Promise<Response> {
  if (fetchImpl) {
    return fetchImpl(input as Parameters<typeof fetch>[0], init);
  }
  // Proxy, NO_PROXY, keepalive and long transport timeouts are intentionally
  // owned by src/cli/proxy.ts and ui/server/utils/proxy.js via undici's global
  // dispatcher. Do not pass a per-request dispatcher here, or config hot-reload
  // of proxy.url/proxy.noProxy would be bypassed.
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

function shouldRetryStatus(status: number, configured?: readonly number[]): boolean {
  if (configured) return configured.includes(status);
  return DEFAULT_RETRY_STATUSES.has(status);
}

function resolveRetryDelay(attempt: number, retry: NetworkRetryOptions, retryAfterHeader?: string | null): number {
  const retryAfter = parseRetryAfterHeader(retryAfterHeader);
  const cap = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (retryAfter !== undefined) return Math.min(cap, retryAfter);
  const base = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const exponential = Math.min(cap, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
  return Math.min(cap, exponential + jitter);
}

function parseRetryAfterHeader(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new NetworkFetchError("network_abort", "Network retry aborted.", signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NetworkFetchError("network_abort", "Network retry aborted.", signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function resolveMethod(input: string | URL | Request, init: RequestInit): string {
  const method = init.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const maybe = error as { code?: unknown; cause?: unknown };
  if (typeof maybe.code === "string") return maybe.code;
  if (maybe.cause && typeof maybe.cause === "object") {
    const causeCode = (maybe.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

function withJsonContentType(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}
