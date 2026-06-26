import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePilotHome } from "../pilot/paths.js";
import {
  DEFAULT_SUDO_PERMISSION_POLICY,
  normalizeSudoPermissionPolicy,
  type PermissionRule,
  type PermissionRuleSet,
  type SudoPermissionPolicy,
} from "./protocol/types.js";

export type PermissionSettings = {
  version: 1;
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  sudoPolicy: SudoPermissionPolicy;
  lastUpdated?: string;
};

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  version: 1,
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: true,
  sudoPolicy: DEFAULT_SUDO_PERMISSION_POLICY,
};

const TOOL_NAME_ALIASES = new Map<string, string>([
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["NotebookEdit", "edit_notebook"],
  ["MultiEdit", "edit_file"],
  ["Glob", "glob"],
  ["Grep", "grep"],
  ["Bash", "bash"],
  ["Task", "agent"],
  ["TodoWrite", "todo_write"],
  ["WebFetch", "web_fetch"],
  ["WebSearch", "web_search"],
]);

export function getPermissionSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePilotHome(env), "permissions.json");
}

export function readPermissionSettings(env: NodeJS.ProcessEnv = process.env): PermissionSettings {
  try {
    const raw = readFileSync(getPermissionSettingsPath(env), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizePermissionSettings(parsed);
  } catch {
    return normalizePermissionSettings(DEFAULT_PERMISSION_SETTINGS);
  }
}

export function writePermissionSettings(
  settings: Partial<PermissionSettings>,
  env: NodeJS.ProcessEnv = process.env,
): PermissionSettings {
  const next = normalizePermissionSettings({
    ...readPermissionSettings(env),
    ...settings,
    lastUpdated: new Date().toISOString(),
  });
  const filePath = getPermissionSettingsPath(env);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function permissionSettingsToRuleSet(settings: PermissionSettings): PermissionRuleSet {
  return {
    allow: settings.allowedTools.map((entry) => permissionEntryToRule(entry, "allow")),
    deny: settings.disallowedTools.map((entry) => permissionEntryToRule(entry, "deny")),
    ask: [],
  };
}

export function normalizePermissionEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";

  const bashMatch = /^Bash\((.*)\)$/.exec(trimmed);
  if (bashMatch) {
    const pattern = bashMatch[1]?.trim();
    return pattern ? `bash:${pattern}` : "bash";
  }

  return TOOL_NAME_ALIASES.get(trimmed) ?? trimmed;
}

export function normalizePermissionSettings(value: unknown): PermissionSettings {
  const record = isRecord(value) ? value : {};
  return {
    version: 1,
    allowedTools: normalizeStringArray(record.allowedTools),
    disallowedTools: normalizeStringArray(record.disallowedTools),
    skipPermissions: Boolean(record.skipPermissions),
    sudoPolicy: normalizeSudoPermissionPolicy(record.sudoPolicy),
    lastUpdated: typeof record.lastUpdated === "string" ? record.lastUpdated : undefined,
  };
}

export function permissionEntryToRule(
  entry: string,
  behavior: "allow" | "deny",
  source: PermissionRule["source"] = "user",
): PermissionRule {
  const normalized = normalizePermissionEntry(entry);
  const [toolName, ...patternParts] = normalized.split(":");
  const pattern = patternParts.join(":").trim();
  return {
    source,
    behavior,
    toolName: toolName || normalized,
    pattern: pattern || undefined,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = normalizePermissionEntry(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
