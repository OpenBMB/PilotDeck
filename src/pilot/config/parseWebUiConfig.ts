import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic, PilotWebUiConfig } from "./types.js";

export const DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB = 20;
export const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * Keep the core runtime's transcription limit aligned with the Web upload
 * setting without taking ownership of unrelated Web UI configuration.
 */
export function parseWebUiConfig(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotWebUiConfig {
  const defaults: PilotWebUiConfig = {
    attachments: { maxFileSizeMB: DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB },
  };
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "WEBUI_CONFIG_INVALID",
      severity: "fatal",
      message: "webui must be an object.",
      path: "webui",
      recoverable: false,
    });
    return defaults;
  }

  const attachments = raw.attachments;
  if (attachments === undefined) return defaults;
  if (!isRecord(attachments)) {
    diagnostics.push({
      code: "WEBUI_ATTACHMENTS_INVALID",
      severity: "fatal",
      message: "webui.attachments must be an object.",
      path: "webui.attachments",
      recoverable: false,
    });
    return defaults;
  }

  const maxFileSizeMB = attachments.maxFileSizeMB;
  if (!isPositiveSafeInteger(maxFileSizeMB)) {
    diagnostics.push({
      code: "WEBUI_ATTACHMENTS_MAX_FILE_SIZE_INVALID",
      severity: "fatal",
      message: "webui.attachments.maxFileSizeMB must be a positive safe integer that can be converted to bytes.",
      path: "webui.attachments.maxFileSizeMB",
      recoverable: false,
    });
    return defaults;
  }
  return { attachments: { maxFileSizeMB } };
}

export function chatAttachmentMaxFileSizeBytes(config: PilotWebUiConfig | undefined): number {
  return (config?.attachments.maxFileSizeMB ?? DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB) * BYTES_PER_MEBIBYTE;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MEBIBYTE);
}
