import { afterEach, expect, it, vi } from 'vitest';
import { initializePreferencePersistence } from './preferencePersistence';

const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
afterEach(() => { Storage.prototype.setItem = set; Storage.prototype.removeItem = remove; vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
it('hydrates before mount, persists edits, and excludes auth tokens', async () => {
  localStorage.clear(); localStorage.setItem('themeMode', 'light'); localStorage.setItem('auth-token', 'secret-token');
  const fetcher = vi.fn(async (_url, options: RequestInit) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ userId: 1, entries: { themeMode: 'dark' } }) };
    return { ok: true, json: async () => ({ entries: {} }) };
  });
  vi.stubGlobal('fetch', fetcher);
  await initializePreferencePersistence();
  expect(localStorage.getItem('themeMode')).toBe('dark');
  localStorage.setItem('themeMode', 'light');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body as string)).toEqual({ changes: { themeMode: 'light' } });
  expect(fetcher.mock.calls.every(([, options]) => !String(options.body || '').includes('secret-token'))).toBe(true);
});
