
export type VideoGenerationConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Model-specific defaults serialized as the extra_params multipart field. */
  extraParams?: Record<string, unknown>;
};

export const DEFAULT_VIDEO_BASE_URL = "http://localhost:8000/v1";

export function videoApiBaseUrl(value = DEFAULT_VIDEO_BASE_URL): string {
  const url = new URL(value.trim() || DEFAULT_VIDEO_BASE_URL);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Video API address must be an HTTP(S) URL without credentials, query or fragment.");
  }
  if (/\/videos\/sync\/?$/.test(url.pathname)) throw new Error("Use the Videos API base URL, such as http://localhost:8000/v1.");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/videos$/, "");
  return url.toString().replace(/\/+$/, "");
}
