import path from 'node:path';
import { readConfiguration, updateConfiguration, resolveConfigHome } from '@pilotdeck/config';

// Authentication/session history stays in SQLite. User settings and secrets have
// one durable YAML authority, independent of the installed application directory.
export function createYamlConfiguration(db, home = () => resolveConfigHome()) {
  const file = () => path.join(home(), 'credentials', 'web.yaml');
  function legacy(query) {
    try { return db.prepare(query).all(); } catch { return []; }
  }
  function read(section, fallback = () => []) {
    const initial = readConfiguration(file(), { create: false, repair: false }).value;
    const shape = section === 'app' ? {} : section === 'webPush' ? { publicKey: '', privateKey: '' } : [];
    const defaults = { [section]: Object.hasOwn(initial, section) ? shape : fallback() };
    return readConfiguration(file(), { defaults, normalize: (value, issue) => {
      if (section === 'app') {
        for (const [key, entry] of Object.entries(value.app)) {
          if (typeof entry !== 'string') { delete value.app[key]; issue(`app.${key}`, 'Expected a string; ignoring invalid setting.'); }
        }
      } else if (Array.isArray(shape)) {
        value[section] = value[section].filter((row, index) => {
          const valid = row && typeof row === 'object' && Number.isSafeInteger(row.id) && Number.isSafeInteger(row.user_id)
            && (section === 'apiKeys' ? typeof row.api_key === 'string' : typeof row.credential_value === 'string');
          if (!valid) issue(`${section}.${index}`, 'Invalid credential record; ignoring this record.');
          if (valid && row.is_active !== 0 && row.is_active !== 1) { row.is_active = 0; issue(`${section}.${index}.is_active`, 'Invalid active flag; disabling this credential.'); }
          return valid;
        });
      }
      return value;
    } }).value[section];
  }
  function update(section, change, fallback = () => []) {
    const loaded = read(section, fallback);
    return updateConfiguration(file(), current => {
      const previous = current[section] ?? loaded;
      const sequences = Array.isArray(previous) ? { ...current.sequences, [section]: Math.max(Number(current.sequences?.[section]) || 0, ...previous.map(row => Number(row.id) || 0)) } : current.sequences;
      return { ...current, ...(sequences ? { sequences } : {}), [section]: change(previous) };
    })[section];
  }
  function insert(section, row, fallback) {
    const loaded = read(section, fallback);
    let result;
    updateConfiguration(file(), current => {
      const rows = current[section] ?? loaded;
      const id = Math.max(Number(current.sequences?.[section]) || 0, ...rows.map(item => Number(item.id) || 0)) + 1;
      result = { ...row, id, created_at: new Date().toISOString(), is_active: 1 };
      return { ...current, [section]: [...rows, result], sequences: { ...current.sequences, [section]: id } };
    });
    return result;
  }
  return { read, update, insert, legacy };
}
