import { FormData } from "undici";
import { networkFetch } from "../../../network/fetch.js";
import { resolveApiKey } from "../../../model/config/resolveCredentials.js";
import { imageApiBaseUrl, type ImageGenerationConfig } from "../../../pilot/config/imageGenerationConfig.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export type ImageRequest = { prompt: string; size?: string; quality?: string; background?: string;
  references?: Array<{ bytes: Buffer; mimeType: string }> };

async function boundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The image service returned an empty response.");
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("The image service response exceeds the size limit.");
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function requestOpenAIImage(config: ImageGenerationConfig, input: ImageRequest, options: {
  signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
} = {}): Promise<Buffer> {
  if (config.enabled !== true) throw new Error("Image generation is disabled.");
  const key = resolveApiKey(config.apiKey, options.env);
  const base = imageApiBaseUrl(config.baseUrl);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(180_000)]);
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  const fields = { model: config.model, prompt: input.prompt, n: 1,
    ...(input.size ? { size: input.size } : {}), ...(input.quality ? { quality: input.quality } : {}),
    ...(input.background ? { background: input.background } : {}) };
  let body: string | FormData;
  if (input.references?.length) {
    // networkFetch uses undici.fetch, which requires its own FormData implementation.
    // Node's built-in FormData can otherwise be serialized as "[object FormData]".
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
    for (const [index, image] of input.references.entries()) {
      form.append(input.references.length === 1 ? "image" : "image[]", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png"}`);
    }
    body = form;
  } else { headers["content-type"] = "application/json"; body = JSON.stringify(fields); }
  try {
    const response = await networkFetch(`${base}/images/${input.references?.length ? "edits" : "generations"}`, {
      // DOM BodyInit does not include undici's separate FormData type.
      method: "POST", headers, body: body as BodyInit, redirect: "error",
    }, { signal, fetchImpl: options.fetchImpl, retry: { maxRetries: 0 } });
    const text = (await boundedBytes(response, response.ok ? MAX_IMAGE_BYTES * 1.4 : 8192, signal)).toString("utf8");
    if (!response.ok) {
      let message = `Image API returned HTTP ${response.status}.`;
      try { const error = JSON.parse(text); if (typeof error.error?.message === "string") message += ` ${error.error.message}`; } catch {}
      throw new Error(message);
    }
    const image = JSON.parse(text).data?.[0];
    if (typeof image?.b64_json === "string" && image.b64_json) {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(image.b64_json)) throw new Error("Invalid image encoding.");
      const bytes = Buffer.from(image.b64_json, "base64");
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Invalid image size.");
      return bytes;
    }
    if (typeof image?.url === "string") {
      const url = new URL(image.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid image download URL.");
      // Provider credentials never travel to a returned CDN URL.
      const download = await networkFetch(url, { redirect: "error" }, { signal, fetchImpl: options.fetchImpl });
      if (!download.ok) throw new Error(`Image download returned HTTP ${download.status}.`);
      return await boundedBytes(download, MAX_IMAGE_BYTES, signal);
    }
    throw new Error("The image service returned no image.");
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (signal.aborted) throw new Error("Image generation timed out. The provider may still be processing it; check before retrying.");
    const message = error instanceof Error ? error.message : "Image generation failed.";
    throw new Error(message.split(key).join("[REDACTED]").slice(0, 1200));
  }
}
