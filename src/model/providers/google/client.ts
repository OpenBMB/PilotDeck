import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type HttpOptions,
} from "@google/genai";
import type { ProviderConfig } from "../../protocol/canonical.js";

export type GoogleModelClient = {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    generateContentStream(params: GenerateContentParameters): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
};

export type GoogleClientFactory = (provider: ProviderConfig) => GoogleModelClient;

export function createGoogleClient(provider: ProviderConfig): GoogleModelClient {
  const resolved = resolveGoogleEndpoint(provider.url);
  const httpOptions: HttpOptions = {
    headers: provider.headers,
    ...(provider.timeoutMs ? { timeout: provider.timeoutMs } : {}),
    ...(provider.extraBody ? { extraBody: provider.extraBody } : {}),
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
  };

  return new GoogleGenAI({
    apiKey: provider.apiKey,
    ...(resolved.apiVersion !== undefined ? { apiVersion: resolved.apiVersion } : {}),
    httpOptions,
  });
}

export function resolveGoogleEndpoint(rawUrl: string): { baseUrl?: string; apiVersion?: string } {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return {};
  }

  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts.at(-1);
    if (last === "v1" || last === "v1beta") {
      url.pathname = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}/` : "/";
      url.search = "";
      url.hash = "";
      return { baseUrl: url.toString(), apiVersion: last };
    }

    if (url.hostname.toLowerCase() === "generativelanguage.googleapis.com" && parts.length === 0) {
      return {};
    }

    url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    url.search = "";
    url.hash = "";
    return { baseUrl: url.toString(), apiVersion: "" };
  } catch {
    return { baseUrl: trimmed, apiVersion: "" };
  }
}
