import {
  PILOTDECK_SETTINGS_KEY,
  getPilotDeckSettings,
  safeLocalStorage,
  savePilotDeckPermissionSettings,
} from "../../../../chat/utils/chatStorage";
import type { PilotDeckSettings } from "../../../../chat/types/types";
import type { ParsedPermissionsImport, PermissionsExport } from "../types";

export const addUnique = (items: string[], value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed || items.includes(trimmed)) return items;
  return [...items, trimmed];
};

export const removeValue = (items: string[], value: string): string[] =>
  items.filter((item) => item !== value);

export const mergeUnique = (a: string[], b: string[]): string[] => {
  const seen = new Set(a);
  const out = [...a];
  for (const item of b) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
};

export function persistPermissionSettings(updates: Partial<PilotDeckSettings>) {
  const current = getPilotDeckSettings();
  const next: PilotDeckSettings = {
    ...current,
    ...updates,
    lastUpdated: new Date().toISOString(),
  };
  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("pilotdeck-settings-changed"));
  savePilotDeckPermissionSettings(updates).catch((error) => {
    console.error("Failed to persist permission settings to backend:", error);
  });
  return next;
}

export function buildExportPayload(): PermissionsExport {
  const settings = getPilotDeckSettings();
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    source: "pilotdeck",
    allowedTools: settings.allowedTools,
    disallowedTools: settings.disallowedTools,
    skipPermissions: settings.skipPermissions,
  };
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function parsePermissionsImport(raw: string): ParsedPermissionsImport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  };

  const allowedTools = toStringArray(obj.allowedTools);
  const disallowedTools = toStringArray(obj.disallowedTools);

  if (
    allowedTools.length === 0 &&
    disallowedTools.length === 0 &&
    typeof obj.skipPermissions !== "boolean"
  ) {
    return null;
  }

  return {
    allowedTools,
    disallowedTools,
    skipPermissions:
      typeof obj.skipPermissions === "boolean" ? obj.skipPermissions : undefined,
  };
}
