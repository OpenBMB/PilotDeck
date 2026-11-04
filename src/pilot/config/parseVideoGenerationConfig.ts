import type { PilotConfigDiagnostic } from "./types.js";
import { isRecord } from "../../model/config/schema.js";
import { videoApiBaseUrl, type VideoGenerationConfig } from "./videoGenerationConfig.js";

export function parseVideoGenerationConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): VideoGenerationConfig | undefined {
  if (raw === undefined) return undefined;
  const fail = (field: string, message: string) => diagnostics.push({ code: "TOOLS_VIDEO_GENERATION_INVALID", severity: "fatal", message,
    path: `tools.videoGeneration${field ? `.${field}` : ""}`, recoverable: false });
  if (!isRecord(raw)) { fail("", "videoGeneration must be an object."); return undefined; }
  const config: VideoGenerationConfig = { enabled: raw.enabled === true };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") fail("enabled", "enabled must be a boolean.");
  for (const key of ["apiKey", "baseUrl", "model"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") fail(key, `${key} must be a string.`);
    else config[key] = raw[key].trim();
  }
  if (raw.extraParams !== undefined) {
    if (!isRecord(raw.extraParams) || JSON.stringify(raw.extraParams).length > 8192) fail("extraParams", "Model parameters must be a JSON object no larger than 8 KB.");
    else config.extraParams = raw.extraParams;
  }
  if (config.baseUrl) {
    try { config.baseUrl = videoApiBaseUrl(config.baseUrl); } catch { fail("baseUrl", "Invalid video API address."); }
  }
  if (config.enabled) {
    if (!config.apiKey) fail("apiKey", "An API key is required when video generation is enabled.");
    if (!config.model) fail("model", "A model is required when video generation is enabled.");
  }
  return config;
}
