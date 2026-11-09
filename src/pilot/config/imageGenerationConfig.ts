
export type ImageGenerationConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export const DEFAULT_IMAGE_BASE_URL = "https://api.openai.com/v1";

export function imageApiBaseUrl(value = DEFAULT_IMAGE_BASE_URL): string {
  const url = new URL(value.trim() || DEFAULT_IMAGE_BASE_URL);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Image API address must be an HTTP(S) URL without credentials, query or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/images\/(?:generations|edits)$/, "");
  return url.toString().replace(/\/+$/, "");
}
