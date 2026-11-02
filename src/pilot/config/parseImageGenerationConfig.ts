import type { PilotConfigDiagnostic } from "./types.js";
import { isRecord } from "../../model/config/schema.js";
import { imageApiBaseUrl, type ImageGenerationConfig } from "./imageGenerationConfig.js";

export function parseImageGenerationConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): ImageGenerationConfig | undefined {
  if (raw === undefined) return undefined;
  const fail = (field: string, message: string) => diagnostics.push({ code: "TOOLS_IMAGE_GENERATION_INVALID", severity: "fatal", message,
    path: `tools.imageGeneration${field ? `.${field}` : ""}`, recoverable: false });
  if (!isRecord(raw)) { fail("", "imageGeneration must be an object."); return undefined; }
  const config: ImageGenerationConfig = { enabled: raw.enabled === true };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") fail("enabled", "enabled must be a boolean.");
  for (const key of ["apiKey", "baseUrl", "model"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") fail(key, `${key} must be a string.`);
    else config[key] = raw[key].trim();
  }
  if (config.baseUrl) {
    try { config.baseUrl = imageApiBaseUrl(config.baseUrl); } catch { fail("baseUrl", "Invalid image API address."); }
  }
  if (config.enabled) {
    if (!config.apiKey) fail("apiKey", "An API key is required when image generation is enabled.");
    if (!config.model) fail("model", "A model is required when image generation is enabled.");
  }
  return config;
}
