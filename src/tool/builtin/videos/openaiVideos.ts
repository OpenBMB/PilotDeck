import { FormData } from "undici";
import { setTimeout as delay } from "node:timers/promises";
import { networkFetch } from "../../../network/fetch.js";
import { resolveApiKey } from "../../../model/config/resolveCredentials.js";
import { videoApiBaseUrl, type VideoGenerationConfig } from "../../../pilot/config/videoGenerationConfig.js";

export type VideoRequest = { prompt: string; seconds?: number; size?: string; num_inference_steps?: number; seed?: number; extra_params?: Record<string, unknown> };
export const VIDEO_TIMEOUT_MS = 20 * 60_000;

async function json(response: Response): Promise<Record<string, any>> {
  // Bound provider errors and status responses independently of the video stream.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Video API returned an empty response.");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 64 * 1024) throw new Error("Video API status response is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`Video API returned a non-JSON response (HTTP ${response.status}). Check the API address and Videos API support.`); }
  if (!response.ok) throw new Error(`Video API returned HTTP ${response.status}. ${typeof data.error?.message === "string" ? data.error.message : typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : typeof data.message === "string" ? data.message : ""}`);
  return data;
}

/** networkFetch releases its header-time abort forwarding; retain cancellation for streamed bodies. */
function streamed(response: Response, signal: AbortSignal): Response {
  const reader = response.body?.getReader();
  if (!reader) return response;
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => { void reader.cancel(signal.reason).catch(() => {}); controller.error(new Error("Video request cancelled or timed out.")); cleanup(); };
      cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read(); signal.throwIfAborted();
        if (done) { cleanup(); controller.close(); } else controller.enqueue(value);
      } catch (error) { cleanup(); controller.error(error); }
    },
    async cancel(reason) { cleanup(); await reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

export class VideoApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
  get retryable() { return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500; }
}
export type VideoTransportOptions = { signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; pollMs?: number; timeoutMs?: number };
export function videoClient(config: VideoGenerationConfig, options: VideoTransportOptions = {}) {
  const key = resolveApiKey(config.apiKey, options.env);
  const base = videoApiBaseUrl(config.baseUrl);
  const request = async (path: string, init: RequestInit = {}) => {
    const signal = options.signal ?? AbortSignal.timeout(60_000);
    try {
      return streamed(await networkFetch(base + path, { ...init, headers: { authorization: `Bearer ${key}` }, redirect: "error" },
        { signal, fetchImpl: options.fetchImpl, retry: { maxRetries: 0 } }), signal);
    } catch { throw new VideoApiError("Cannot reach the video service."); }
  };
  const read = async (response: Response) => {
    try { return await json(response); }
    catch (error) {
      const text = error instanceof Error ? error.message : "Invalid video response.";
      throw new VideoApiError((key ? text.split(key).join("[REDACTED]") : text).slice(0, 1200), response.ok ? undefined : response.status);
    }
  };
  return {
    async submit(input: VideoRequest) {
      const body = new FormData();
      const extra = { ...config.extraParams, ...input.extra_params };
      if (Object.keys(extra).length) body.append("extra_params", JSON.stringify(extra));
      for (const [name, value] of Object.entries({ model: config.model, prompt: input.prompt, seconds: input.seconds ?? 5, size: input.size, num_inference_steps: input.num_inference_steps, seed: input.seed })) {
        if (value !== undefined) body.append(name, String(value));
      }
      const status = await read(await request("/videos", { method: "POST", body: body as unknown as BodyInit }));
      if (typeof status.id !== "string" || !status.id || status.id.length > 256) throw new Error("Video API returned no valid job ID.");
      return status;
    },
    status: async (id: string) => read(await request(`/videos/${encodeURIComponent(id)}`)),
    async content(id: string) {
      const response = await request(`/videos/${encodeURIComponent(id)}/content`);
      if (!response.ok) await read(response);
      return response;
    },
  };
}

/** Ephemeral settings probe. Production generations use the durable VideoJobManager. */
export async function requestOpenAIVideo(config: VideoGenerationConfig, input: VideoRequest, options: VideoTransportOptions = {}): Promise<Response> {
  if (config.enabled !== true) throw new Error("Video generation is disabled.");
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? VIDEO_TIMEOUT_MS)]);
  const client = videoClient(config, { ...options, signal });
  try {
    let status = await client.submit(input);
    const id = status.id;
    while (status.status !== "completed") {
      if (["failed", "cancelled"].includes(status.status)) throw new Error(`Video generation ${status.status}. ${typeof status.error?.message === "string" ? status.error.message : ""}`);
      if (!["queued", "in_progress", "pending", "processing"].includes(status.status)) throw new Error(`Unsupported video job status: ${String(status.status).slice(0, 80)}`);
      await delay(options.pollMs ?? 2000, undefined, { signal });
      status = await client.status(id);
    }
    return await client.content(id);
  } catch (error) {
    if (signal.aborted) throw new Error("Video generation timed out or waiting was cancelled. The provider may still be processing it.");
    throw error;
  }
}
