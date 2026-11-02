import { readConfiguration, updateConfiguration } from '@pilotdeck/config';
import path from 'path';
import { resolvePilotHome } from '../utils/pilotPaths.js';

const DEFAULT_SETTINGS = {
  version: 1,
  allowedTools: [],
  askTools: [],
  disallowedTools: [],
  skipPermissions: false,
};

const TOOL_NAME_ALIASES = new Map([
  ['Read', 'read_file'],
  ['Write', 'write_file'],
  ['Edit', 'edit_file'],
  ['NotebookEdit', 'edit_notebook'],
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
  return path.join(resolvePilotHome(env), 'permissions.yaml');
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
    askTools: normalizeStringArray(obj.askTools),
    disallowedTools: normalizeStringArray(obj.disallowedTools),
    skipPermissions: obj.skipPermissions === true,
    lastUpdated: typeof obj.lastUpdated === 'string' ? obj.lastUpdated : undefined,
  };
}

export function readPermissionSettings(env = process.env) {
  return readConfiguration(getPermissionSettingsPath(env), {
    defaults: DEFAULT_SETTINGS, legacyPaths: [path.join(resolvePilotHome(env), 'permissions.json')], normalize: normalizePermissionSettings,
  }).value;
}

export function writePermissionSettings(updates, env = process.env) {
  readPermissionSettings(env);
  return updateConfiguration(getPermissionSettingsPath(env), current => normalizePermissionSettings({
    ...current,
    ...(updates || {}),
    lastUpdated: new Date().toISOString(),
  }), { defaults: DEFAULT_SETTINGS });
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
