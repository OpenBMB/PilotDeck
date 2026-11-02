import path from 'node:path';
import { readConfiguration, updateConfiguration } from '@pilotdeck/config';
import { userConfigurationDirectory } from './userConfiguration.js';
import { decodePreference, isPreferenceKey, normalizePreferenceDocument } from '../config/preferenceSchema.js';

export { userConfigurationDirectory } from './userConfiguration.js';
export function createUserPreferences(userId, home) {
  const file = path.join(userConfigurationDirectory(userId, home), 'preferences.yaml');
  const options = { defaults: { values: {}, jsonKeys: [] }, normalize: normalizePreferenceDocument };
  function read() { return readConfiguration(file, options).value; }
  function entries(document) {
    const json = new Set(document.jsonKeys);
    return Object.fromEntries(Object.entries(document.values).map(([key, value]) => [key, json.has(key) ? JSON.stringify(value) : String(value)]));
  }
  function update(changes, migrate = false) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length > 256) throw new Error('Invalid preference patch');
    for (const [key, raw] of Object.entries(changes)) {
      if (!isPreferenceKey(key) || raw !== null && (typeof raw !== 'string' || raw.length > 128 * 1024)) throw new Error('Invalid preference entry');
    }
    read();
    const next = updateConfiguration(file, current => {
      if (migrate && current.browserImported === true) return current;
      const values = { ...current.values }, jsonKeys = new Set(current.jsonKeys);
      for (const [key, raw] of Object.entries(changes)) {
        // Only the first browser snapshot supplies missing values. Existing YAML
        // always wins over a stale cache after an application update.
        if (migrate && Object.hasOwn(values, key)) continue;
        if (raw === null) { delete values[key]; jsonKeys.delete(key); continue; }
        const decoded = decodePreference(raw); values[key] = decoded.value;
        if (decoded.json) jsonKeys.add(key); else jsonKeys.delete(key);
      }
      return normalizePreferenceDocument({ ...current, ...(migrate ? { browserImported: true } : {}), values, jsonKeys: [...jsonKeys] });
    }, options);
    return entries(next);
  }
  return { file, read: () => entries(read()), update };
}
