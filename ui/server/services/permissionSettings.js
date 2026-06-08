import fs from 'fs';
import path from 'path';
import { resolvePilotHome } from '../utils/pilotPaths.js';

const DEFAULT_SETTINGS = {
  version: 1,
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: true,
};

const TOOL_NAME_ALIASES = new Map([
  ['Read', 'read_file'],
  ['Write', 'write_file'],
  ['Edit', 'edit_file'],
  ['MultiEdit', 'edit_file'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['Bash', 'bash'],
  ['Task', 'agent'],
  ['TodoWrite', 'todo_write'],
  ['WebFetch', 'web_fetch'],
  ['WebSearch', 'web_search'],
]);

export function getPermissionSettingsPath(env = process.env) {
  return path.join(resolvePilotHome(env), 'permissions.json');
}

export function normalizePermissionEntry(entry) {
  const trimmed = typeof entry === 'string' ? entry.trim() : '';
  if (!trimmed) return '';
  const bashMatch = /^Bash\((.*)\)$/.exec(trimmed);
  if (bashMatch) {
    const pattern = bashMatch[1]?.trim();
    return pattern ? `bash:${pattern}` : 'bash';
  }
  return TOOL_NAME_ALIASES.get(trimmed) || trimmed;
}

export function normalizePermissionSettings(value) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    allowedTools: normalizeStringArray(obj.allowedTools),
    disallowedTools: normalizeStringArray(obj.disallowedTools),
    skipPermissions: Boolean(obj.skipPermissions),
    lastUpdated: typeof obj.lastUpdated === 'string' ? obj.lastUpdated : undefined,
  };
}

export function readPermissionSettings(env = process.env) {
  try {
    const raw = fs.readFileSync(getPermissionSettingsPath(env), 'utf8');
    return normalizePermissionSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writePermissionSettings(updates, env = process.env) {
  const current = readPermissionSettings(env);
  const next = normalizePermissionSettings({
    ...current,
    ...(updates || {}),
    lastUpdated: new Date().toISOString(),
  });
  const filePath = getPermissionSettingsPath(env);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`[permissionSettings] Failed to write ${filePath}:`, err);
    throw err;
  }
  return next;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const normalized = normalizePermissionEntry(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
