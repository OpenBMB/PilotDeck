import { describe, expect, it, vi } from 'vitest';
import {
  clearDynamicImportReloadMarker,
  isDynamicImportLoadError,
  reloadOnceForDynamicImportError,
} from './reloadOnChunkError';

describe('dynamic import reload recovery', () => {
  it('detects browser dynamic import fetch failures', () => {
    expect(isDynamicImportLoadError(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:3001/assets/index-51NXb8Tj.js'))).toBe(true);
    expect(isDynamicImportLoadError(new Error('Loading chunk DashboardV2 failed.'))).toBe(true);
    expect(isDynamicImportLoadError(new Error('ordinary application error'))).toBe(false);
  });

  it('reloads only once for a missing chunk', () => {
    const win = createWindowStub();

    expect(reloadOnceForDynamicImportError(new Error('Failed to fetch dynamically imported module'), win)).toBe(true);
    expect(win.location.reload).toHaveBeenCalledTimes(1);

    expect(reloadOnceForDynamicImportError(new Error('Failed to fetch dynamically imported module'), win)).toBe(false);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it('clears the reload marker after a successful load', () => {
    const win = createWindowStub();

    reloadOnceForDynamicImportError(new Error('Failed to fetch dynamically imported module'), win);
    clearDynamicImportReloadMarker(win);

    expect(reloadOnceForDynamicImportError(new Error('Failed to fetch dynamically imported module'), win)).toBe(true);
    expect(win.location.reload).toHaveBeenCalledTimes(2);
  });
});

function createWindowStub() {
  const values = new Map<string, string>();
  return {
    sessionStorage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    },
    location: {
      reload: vi.fn(),
    },
  } as unknown as Pick<Window, 'sessionStorage' | 'location'>;
}
