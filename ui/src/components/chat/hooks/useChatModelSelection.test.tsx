import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatModelSelection } from './useChatModelSelection';
import { createGlobalModelSelectionStore, GLOBAL_MODEL_SELECTION_KEY } from '../utils/globalModelSelection';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), store: null as any }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../utils/globalModelSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/globalModelSelection')>(),
  get globalModelSelectionStore() { return mocks.store; },
}));
const A = { mode: 'model' as const, provider: 'alpha', model: 'first' };
const B = { mode: 'model' as const, provider: 'zeta', model: 'configured', reasoning: 0.8, temperature: 0.3, speed: 1 };
const items = [A, B].map((s) => ({ id: `${s.provider}/${s.model}`, provider: s.provider, model: s.model, displayName: s.model, available: true, capabilities: {} }));
const catalog = { items: [{ id: 'router/auto', provider: 'router', model: 'auto', displayName: 'Auto', available: true, capabilities: {} }, ...items], defaultSelection: B };
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const listeners = new Set<(message: any) => void>();
const subscribe = (fn: (message: any) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = (message: any) => act(() => {
  // The WebSocket provider invalidates the shared catalog before notifying consumers.
  if (message.type === 'config:reloaded' || message.type === 'websocket-reconnected') mocks.store.invalidate();
  for (const listener of listeners) listener(message);
});
const setup = () => renderHook(() => useChatModelSelection({ subscribe }));
const ready = async (hook: ReturnType<typeof setup>) => waitFor(() => expect(hook.result.current.isModelSelectionReady).toBe(true));
const saved = () => JSON.parse(localStorage.getItem(GLOBAL_MODEL_SELECTION_KEY) || 'null');
beforeEach(() => {
  localStorage.clear(); mocks.fetch.mockReset(); listeners.clear();
  mocks.fetch.mockResolvedValue(json(catalog));
  mocks.store = createGlobalModelSelectionStore();
});
afterEach(cleanup);

describe('global model selection', () => {
  it('uses the configured default, never the first catalog row, without saving it as a manual preference', async () => {
    const hook = setup();
    expect(hook.result.current.isModelSelectionReady).toBe(false);
    await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(B);
    expect(saved()).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/api/models?includeAuto=true');
  });

  it('restores exact global parameters and ignores all old project/session drafts', async () => {
    const choice = { ...B, reasoning: 0.2, temperature: undefined, speed: undefined };
    localStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(choice));
    localStorage.setItem('composer-model-/project', JSON.stringify(A));
    localStorage.setItem('pending-composer-model-["/project","web:old"]', JSON.stringify({ selection: A, id: 'old' }));
    const hook = setup();
    await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(choice);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('shares the latest choice across mounted composers and remounts without another request or loading gap', async () => {
    const first = setup(), second = setup();
    await ready(first); await ready(second);
    await act(() => first.result.current.setModelSelection(A));
    expect(second.result.current.modelSelection).toEqual(A);
    first.unmount(); second.unmount();
    const next = setup();
    expect(next.result.current.modelSelection).toEqual(A);
    expect(next.result.current.isModelSelectionReady).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(saved()).toEqual(A);
  });

  it('persists the latest manual choice across a full application reload without a session GET or PUT', async () => {
    const first = setup(); await ready(first);
    await act(() => first.result.current.setModelSelection(A));
    first.unmount();
    mocks.store = createGlobalModelSelectionStore();
    const next = setup(); await ready(next);
    expect(next.result.current.modelSelection).toEqual(A);
    expect(mocks.fetch.mock.calls.every(([url]) => url === '/api/models?includeAuto=true')).toBe(true);
  });

  it('never lets old A/B queue acknowledgements, replay, completion or session creation overwrite the latest A', async () => {
    const hook = setup(); await ready(hook);
    for (const choice of [A, B, A]) await act(() => hook.result.current.setModelSelection(choice));
    emit({ activeTurnMessages: [
      { type: 'model-selection-saved', selection: A, sessionId: 'web:old', runId: 'old-a' },
      { type: 'model-selection-saved', selection: B, sessionId: 'web:old', runId: 'old-b' },
      { kind: 'session_created', newSessionId: 'web:created', runId: 'old-b' },
      { kind: 'complete', runId: 'old-b' },
    ] });
    expect(hook.result.current.modelSelection).toEqual(A);
    expect(saved()).toEqual(A);
    expect(localStorage.length).toBe(1);
  });

  it('keeps Auto selected when execution reports a concrete model', async () => {
    const hook = setup(); await ready(hook);
    await act(() => hook.result.current.setModelSelection({ mode: 'auto' }));
    emit({ type: 'model-selection-changed', sessionId: 'web:busy', modelProvider: A.provider, model: A.model });
    expect(hook.result.current.modelSelection).toEqual({ mode: 'auto' });
    expect(hook.result.current.runningModels['web:busy'].model).toBe(A.model);
    expect(saved()).toEqual({ mode: 'auto' });
  });

  it('preserves an unavailable choice and permits manual recovery', async () => {
    const unavailable = { ...A, model: 'removed' };
    localStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(unavailable));
    const hook = setup();
    await waitFor(() => expect(hook.result.current.isModelCatalogLoading).toBe(false));
    expect(hook.result.current.modelSelection).toEqual(unavailable);
    expect(hook.result.current.isModelSelectionReady).toBe(false);
    expect(hook.result.current.modelCatalogError).toContain('alpha/removed');
    await act(() => hook.result.current.setModelSelection(B));
    expect(hook.result.current.isModelSelectionReady).toBe(true);
  });

  it('updates untouched defaults after configuration changes but never overrides a manual preference', async () => {
    const hook = setup(); await ready(hook);
    mocks.fetch.mockResolvedValueOnce(json({ ...catalog, defaultSelection: A }));
    emit({ type: 'config:reloaded' });
    await waitFor(() => expect(hook.result.current.modelSelection).toEqual(A));
    expect(saved()).toBeNull();
    await act(() => hook.result.current.setModelSelection(A));
    emit({ type: 'config:reloaded' }); await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(A);
    expect(saved()).toEqual(A);
  });

  it('keeps a choice made during an outstanding catalog refresh and disables removed models after refresh', async () => {
    const hook = setup(); await ready(hook);
    const pending = deferred<ReturnType<typeof json>>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    emit({ type: 'config:reloaded' });
    await act(() => hook.result.current.setModelSelection(A));
    await act(() => pending.resolve(json({ ...catalog, items: [] })));
    expect(hook.result.current.modelSelection).toEqual(A);
    expect(hook.result.current.isModelSelectionReady).toBe(false);
    expect(hook.result.current.modelCatalogError).toContain('alpha/first');
  });

  it('retries after a config change during the first load instead of caching a stale response', async () => {
    const pending = deferred<ReturnType<typeof json>>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const hook = setup();
    emit({ type: 'config:reloaded' });
    mocks.fetch.mockResolvedValueOnce(json({ ...catalog, defaultSelection: A }));
    await act(() => pending.resolve(json(catalog)));
    await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(A);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('synchronizes other tabs and restores the current system default if the preference is cleared', async () => {
    const hook = setup(); await ready(hook);
    localStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(A));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: GLOBAL_MODEL_SELECTION_KEY, storageArea: localStorage })));
    expect(hook.result.current.modelSelection).toEqual(A);
    localStorage.removeItem(GLOBAL_MODEL_SELECTION_KEY);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })));
    expect(hook.result.current.modelSelection).toEqual(B);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes defaults after a configuration change while the composer was unmounted', async () => {
    const first = setup(); await ready(first); first.unmount();
    emit({ type: 'config:reloaded' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValueOnce(json({ ...catalog, defaultSelection: A }));
    const next = setup(); await ready(next);
    expect(next.result.current.modelSelection).toEqual(A);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('recovers catalog failures after reconnect while retaining the user choice', async () => {
    localStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(A));
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: 'Gateway unavailable' } }, 503));
    const hook = setup();
    await waitFor(() => expect(hook.result.current.modelCatalogError).toBe('Gateway unavailable'));
    expect(hook.result.current.isModelSelectionReady).toBe(false);
    emit({ type: 'websocket-reconnected' }); await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(A);
  });
});
