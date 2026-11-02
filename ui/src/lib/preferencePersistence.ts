import { isPreferenceKey } from '../../server/config/preferenceSchema.js';

type Entries = Record<string, string | null>;
let installed: Promise<void> | undefined;

/** Keep existing hooks synchronous while making their durable authority YAML. */
export function initializePreferencePersistence(): Promise<void> {
  if (installed) return installed;
  const storage = window.localStorage;
  const originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem;
  let hydrated = false, applying = false, writing = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Entries = {};
  const token = () => storage.getItem('auth-token');
  async function request(method: string, body?: unknown) {
    const auth = token();
    const response = await fetch('/api/preferences', { method, headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error(`Preferences unavailable (${response.status})`);
    return response.json();
  }
  function snapshot(): Entries {
    const entries: Entries = {};
    for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key && isPreferenceKey(key)) entries[key] = storage.getItem(key); }
    return entries;
  }
  function apply(entries: Entries) {
    applying = true;
    try {
      const before = snapshot();
      for (const key of new Set([...Object.keys(before), ...Object.keys(entries)])) {
        const value = entries[key] ?? null;
        if (value === null) originalRemove.call(storage, key); else originalSet.call(storage, key, value);
        if (before[key] !== value) window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, oldValue: before[key] ?? null, storageArea: storage }));
      }
    } finally { applying = false; }
  }
  async function flush() {
    if (!hydrated || writing || !Object.keys(pending).length) return;
    writing = true;
    const changes = pending, current = generation; pending = {};
    try { await request('PATCH', { changes }); }
    catch { if (current === generation) pending = { ...changes, ...pending }; }
    finally {
      writing = false;
      if (Object.keys(pending).length && hydrated) timer = setTimeout(() => { void flush(); }, 1500);
    }
  }
  async function hydrate() {
    const current = ++generation, dispatchedToken = token(); hydrated = false;
    try {
      const result = await request('GET');
      if (current !== generation || dispatchedToken !== token()) return;
      const owner = String(result.userId);
      const previousOwner = storage.getItem('pilotdeck:preferences-owner');
      // Import pre-YAML preferences only for the same user (or the first owner).
      const local = !previousOwner || previousOwner === owner ? snapshot() : {};
      let entries = result.entries;
      if (Object.keys(local).some(key => !Object.prototype.hasOwnProperty.call(entries, key))) entries = (await request('PATCH', { changes: local, migrate: true })).entries;
      if (current !== generation || dispatchedToken !== token()) return;
      apply({ ...entries, ...pending });
      originalSet.call(storage, 'pilotdeck:preferences-owner', owner); hydrated = true;
      await flush();
    } catch { /* Offline startup retains the cache. Retry on authentication/online. */ }
  }
  function changed(key: string, value: string | null, previous: string | null = null) {
    if (applying) return;
    if (key === 'auth-token') {
      const identity = (raw: string | null) => { try { return JSON.parse(atob(raw!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).userId; } catch { return undefined; } };
      if (value && previous && identity(value) && identity(value) === identity(previous)) return;
      if (timer) clearTimeout(timer);
      pending = {}; apply({}); void hydrate(); return;
    }
    if (!isPreferenceKey(key)) return;
    pending[key] = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 200);
  }
  Storage.prototype.setItem = function(key, value) { const before = this.getItem(key); originalSet.call(this, key, value); if (this === storage && before !== String(value)) changed(key, String(value), before); };
  Storage.prototype.removeItem = function(key) { originalRemove.call(this, key); if (this === storage) changed(key, null); };
  window.addEventListener('online', () => { void hydrate().then(flush); });
  window.addEventListener('pagehide', () => {
    if (!hydrated || !Object.keys(pending).length) return;
    const auth = token();
    void fetch('/api/preferences', { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ changes: pending }) }).catch(() => {});
  });
  installed = hydrate();
  return installed;
}
