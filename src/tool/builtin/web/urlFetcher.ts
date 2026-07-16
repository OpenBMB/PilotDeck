/**
 * Low-level URL fetcher for `web_fetch`.
 *
 * Implements behaviours W3 (HTTP→HTTPS upgrade), W4 (10 MB content cap),
 * W5 (60 s timeout), W6 (10 redirect hops), W7 (permitted redirect),
 * W8 (LRU cache + TTL), W9 (egress proxy detection — skipped, see notes
 * in §5.2), W10 (binary persistence — minimal stub: persistedPath set to
 * `undefined` because PilotDeck's MCP storage is feature-gated; behaviour
 * intentional_difference recorded in checklist), W11 (HTML→Markdown via
 * turndown), W12 (truncation at 100 KB).
 */

import {
  type FetchedCacheEntry,
  URL_CACHE,
} from "./urlContentCache.js";
import {
  isPermittedRedirect,
  upgradeHttpToHttps,
  validateURL,
} from "./urlValidation.js";
import { parseRetryAfterHeader } from "../../../model/index.js";
import { networkFetch } from "../../../network/fetch.js";

export const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 60_000;
export const MAX_REDIRECTS = 10;
export const MAX_MARKDOWN_LENGTH = 100_000;
export const WEB_FETCH_USER_AGENT =
  "PilotDeck/0.1 (+https://github.com/pilotdeck) WebFetch";

export type RedirectInfo = {
  type: "redirect";
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
};

export type WebFetchHttpErrorOptions = {
  url: string;
  status: number;
  statusText: string;
  contentType?: string;
  retryAfterMs?: number;
  bodyPreview?: string;
};

export class WebFetchHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType?: string;
  readonly retryAfterMs?: number;
  readonly bodyPreview?: string;

  constructor(options: WebFetchHttpErrorOptions) {
    const statusLabel = options.statusText
      ? `${options.status} ${options.statusText}`
      : String(options.status);
    super(`HTTP ${statusLabel} while fetching ${options.url}.`);
    this.name = "WebFetchHttpError";
    this.url = options.url;
    this.status = options.status;
    this.statusText = options.statusText;
    this.contentType = options.contentType;
    this.retryAfterMs = options.retryAfterMs;
    this.bodyPreview = options.bodyPreview;
  }
}

type FetchedHttpRaw = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  buffer: Buffer;
};

function isRedirectInfoInternal(
  value: FetchedHttpRaw | RedirectInfo,
): value is RedirectInfo {
  return (value as RedirectInfo).type === "redirect";
}

export type WebFetchHttpResult =
  | (FetchedCacheEntry & { fromCache: boolean })
  | RedirectInfo;

export type FetchHook = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

const defaultFetchHook: FetchHook = async (url, init) => {
  const res = await networkFetch(url, {
    method: "GET",
    redirect: "manual",
    headers: init.headers,
    signal: init.signal,
  }, {
    timeoutMs: FETCH_TIMEOUT_MS,
    signal: init.signal,
    retry: {
      maxRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    arrayBuffer: () => res.arrayBuffer(),
  };
};

let activeFetchHook: FetchHook = defaultFetchHook;

export function __setWebFetchHookForTesting(hook: FetchHook | null): void {
  activeFetchHook = hook ?? defaultFetchHook;
}

let turndownPromise: Promise<{ turndown(html: string): string }> | undefined;
async function getTurndown(): Promise<{ turndown(html: string): string }> {
  if (!turndownPromise) {
    turndownPromise = import("turndown").then((mod) => {
      const Ctor =
        (mod as unknown as { default?: new () => { turndown(html: string): string } }).default ??
        (mod as unknown as new () => { turndown(html: string): string });
      return new Ctor();
    });
  }
  return turndownPromise;
}

async function fetchWithRedirects(
  url: string,
  signal: AbortSignal,
  depth: number,
): Promise<FetchedHttpRaw | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("fetch timeout")), FETCH_TIMEOUT_MS);
  const onParentAbort = () => timeout.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });

  let res: Awaited<ReturnType<FetchHook>>;
  try {
    res = await activeFetchHook(url, {
      headers: {
        Accept: "text/markdown, text/html, */*",
        "User-Agent": WEB_FETCH_USER_AGENT,
      },
      signal: timeout.signal,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }

  if ([301, 302, 307, 308].includes(res.status)) {
    const location = res.headers["location"];
    if (!location) throw new Error("Redirect missing Location header");
    const redirectUrl = new URL(location, url).toString();
    if (isPermittedRedirect(url, redirectUrl)) {
      return fetchWithRedirects(redirectUrl, signal, depth + 1);
    }
    return {
      type: "redirect",
      originalUrl: url,
      redirectUrl,
      statusCode: res.status,
    };
  }

  if (
    res.status === 403 &&
    res.headers["x-proxy-error"] === "blocked-by-allowlist"
  ) {
    const hostname = new URL(url).hostname;
    throw new Error(
      JSON.stringify({
        error_type: "EGRESS_BLOCKED",
        domain: hostname,
        message: `Access to ${hostname} is blocked by the network egress proxy.`,
      }),
    );
  }

  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_HTTP_CONTENT_LENGTH) {
    throw new Error(
      `Response exceeds maximum content length of ${MAX_HTTP_CONTENT_LENGTH} bytes`,
    );
  }
  const buffer = Buffer.from(ab);
  const out: FetchedHttpRaw = {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    buffer,
  };
  return out;
}

function isBinaryContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/")) return false;
  if (lower.includes("application/json")) return false;
  if (lower.includes("application/xml")) return false;
  if (lower.includes("application/javascript")) return false;
  if (lower.includes("application/x-www-form-urlencoded")) return false;
  if (lower.includes("xml") && !lower.includes("octet")) return false;
  return (
    lower.includes("application/") ||
    lower.includes("image/") ||
    lower.includes("audio/") ||
    lower.includes("video/")
  );
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function buildBodyPreview(buffer: Buffer, contentType: string): string | undefined {
  if (buffer.length === 0) {
    return undefined;
  }
  if (isBinaryContentType(contentType)) {
    return `[Binary ${contentType || "application/octet-stream"} response body (${buffer.length} bytes) omitted]`;
  }
  const preview = buffer
    .toString("utf-8")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (preview.length === 0) {
    return undefined;
  }
  return preview.length > 500 ? `${preview.slice(0, 497).trimEnd()}...` : preview;
}

export async function getURLMarkdownContent(
  url: string,
  signal: AbortSignal,
): Promise<WebFetchHttpResult> {
  if (!validateURL(url)) {
    throw new Error("Invalid URL");
  }

  const cached = URL_CACHE.get(url);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const { upgraded } = upgradeHttpToHttps(url);
  const result = await fetchWithRedirects(upgraded, signal, 0);
  if (isRedirectInfoInternal(result)) {
    return result;
  }

  const { status, statusText, headers, buffer } = result;
  const contentType = headers["content-type"] ?? "";
  const bytes = buffer.length;

  if (status < 200 || status >= 300) {
    throw new WebFetchHttpError({
      url: upgraded,
      status,
      statusText,
      contentType,
      retryAfterMs: parseRetryAfterHeader(readHeader(headers, "retry-after")),
      bodyPreview: buildBodyPreview(buffer, contentType),
    });
  }

  let content: string;
  let contentBytes: number;
  if (contentType.includes("text/html")) {
    const html = buffer.toString("utf-8");
    const td = await getTurndown();
    content = td.turndown(html);
    contentBytes = Buffer.byteLength(content);
  } else if (isBinaryContentType(contentType)) {
    content = `[Binary ${contentType || "application/octet-stream"} content (${bytes} bytes) — not displayed]`;
    contentBytes = Buffer.byteLength(content);
  } else {
    content = buffer.toString("utf-8");
    contentBytes = bytes;
  }

  const entry: FetchedCacheEntry = {
    bytes,
    code: status,
    codeText: statusText,
    content,
    contentType,
  };
  URL_CACHE.set(url, entry, contentBytes);
  return { ...entry, fromCache: false };
}

export function truncateMarkdown(markdown: string): string {
  if (markdown.length <= MAX_MARKDOWN_LENGTH) return markdown;
  return (
    markdown.slice(0, MAX_MARKDOWN_LENGTH) + "\n\n[Content truncated due to length...]"
  );
}
