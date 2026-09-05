import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatModelSelection } from './useChatModelSelection';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/api', () => ({ authenticatedFetch: fetchMock }));
const A = { mode: 'model' as const, provider: 'alpha', model: 'first' };
const B = { mode: 'model' as const, provider: 'zeta', model: 'configured', reasoning: 0.8, temperature: 0.3, speed: 1 };
const items = [A, B].map((s) => ({ id: `${s.provider}/${s.model}`, provider: s.provider, model: s.model, displayName: s.model, available: true, capabilities: {} }));
const catalog = { items: [{ id: 'router/auto', provider: 'router', model: 'auto', displayName: 'Auto', available: true, capabilities: {} }, ...items], defaultSelection: B, router: { autoAvailable: true } };
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
let listener: (message: any) => void;
const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
const setup = (sessionId?: string, projectKey = '/general') => renderHook(
  (props) => useChatModelSelection({ ...props, subscribe }), { initialProps: { sessionId, projectKey } },
);
beforeEach(() => {
  localStorage.clear(); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => json(url.startsWith('/api/models?') ? catalog : { effective: A }));
});
afterEach(cleanup);

describe('dialog model selection', () => {
  it.each(['/general', '/project'])('uses configured default in %s, even with Auto and another model first', async (project) => {
    const { result } = setup(undefined, project);
    expect(result.current.isModelSelectionReady).toBe(false);
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    expect(result.current.modelSelection).toEqual(B);
    expect(localStorage.length).toBe(0);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });
  it('restores exact saved parameters without borrowing project parameters', async () => {
    localStorage.setItem('composer-model-/general', JSON.stringify(B));
    const saved = { ...B, reasoning: 0.2, temperature: undefined, speed: undefined };
    fetchMock.mockImplementation(async (url: string) => json(url.startsWith('/api/models?') ? catalog : { saved, effective: A }));
    const { result } = setup('web:saved');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    expect(result.current.modelSelection).toEqual(saved);
  });
  it('preserves a manual choice when a new session receives its permanent ID', async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    await act(() => result.current.setModelSelection(A));
    rerender({ projectKey: '/general', sessionId: 'web:created' });
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    expect(result.current.modelSelection).toEqual(A);
  });
  it('retains unavailable choices and lets the user select a replacement', async () => {
    const unavailable = { ...A, model: 'removed' };
    localStorage.setItem('composer-model-/general', JSON.stringify(unavailable));
    const { result } = setup();
    await waitFor(() => expect(result.current.isModelCatalogLoading).toBe(false));
    expect(result.current.modelSelection).toEqual(unavailable);
    expect(result.current.isModelSelectionReady).toBe(false);
    expect(result.current.modelCatalogError).toContain('alpha/removed');
    await act(() => result.current.setModelSelection(B));
    expect(result.current.isModelSelectionReady).toBe(true);
  });
  it('keeps a later welcome-page choice when the first submission receives a permanent ID', async () => {
    const { result, rerender } = setup('new-session-123');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    await act(() => result.current.setModelSelection(A));
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'PUT')).toBe(false);
    act(() => listener({ kind: 'session_created', projectKey: '/general', newSessionId: 'web:created' }));
    fetchMock.mockImplementation(async (url: string) => json(url.startsWith('/api/models?') ? catalog : { saved: B }));
    rerender({ projectKey: '/general', sessionId: 'web:created' });
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    expect(result.current.modelSelection).toEqual(A);
  });
  it('keeps sending blocked when returning to a session whose save is still pending', async () => {
    const save = deferred<ReturnType<typeof json>>();
    fetchMock.mockImplementation(async (url: string, opts?: any) => opts?.method === 'PUT'
      ? save.promise : json(url.startsWith('/api/models?') ? catalog : { saved: B }));
    const { result, rerender } = setup('web:saved');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    let saving!: Promise<void>;
    await act(async () => { saving = result.current.setModelSelection(A); });
    rerender({ projectKey: '/other', sessionId: 'web:other' });
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    rerender({ projectKey: '/general', sessionId: 'web:saved' });
    await waitFor(() => expect(result.current.isModelCatalogLoading).toBe(false));
    expect(result.current.modelSelection).toEqual(A);
    expect(result.current.isModelSelectionReady).toBe(false);
    await act(async () => { save.resolve(json({})); await saving; });
    expect(result.current.isModelSelectionReady).toBe(true);
  });
  it('does not let acceptance of an older queued choice erase the next-message draft on reload', async () => {
    const first = setup('web:queued');
    await waitFor(() => expect(first.result.current.isModelSelectionReady).toBe(true));
    await act(() => first.result.current.setModelSelection(B));
    act(() => listener({ type: 'model-selection-saved', sessionId: 'web:queued', selection: A }));
    first.unmount();
    fetchMock.mockImplementation(async (url: string) => json(url.startsWith('/api/models?') ? catalog : { saved: A }));
    const { result } = setup('web:queued');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    expect(result.current.modelSelection).toEqual(B);
    act(() => listener({ type: 'model-selection-saved', sessionId: 'web:queued', selection: B }));
    expect(localStorage.getItem('pending-composer-model-["/general","web:queued"]')).toBeNull();
  });
  it('ignores delayed old-project responses and blocks during scope changes', async () => {
    const old = deferred<ReturnType<typeof json>>();
    fetchMock.mockImplementationOnce(() => old.promise);
    const { result, rerender } = setup();
    rerender({ projectKey: '/project', sessionId: undefined });
    expect(result.current.modelSelection).toBeNull();
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    await act(() => { old.resolve(json({ ...catalog, defaultSelection: A })); });
    expect(result.current.modelSelection).toEqual(B);
  });
  it('keeps a user choice when an earlier config reload finishes later', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    const reload = deferred<ReturnType<typeof json>>();
    fetchMock.mockImplementationOnce(() => reload.promise);
    act(() => listener({ type: 'config:reloaded' }));
    await act(() => result.current.setModelSelection(A));
    await act(() => { reload.resolve(json(catalog)); });
    expect(result.current.modelSelection).toEqual(A);
    expect(result.current.isModelSelectionReady).toBe(true);
  });
  it('refreshes untouched defaults without saving them as explicit preferences', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    fetchMock.mockResolvedValueOnce(json({ ...catalog, defaultSelection: A }));
    act(() => listener({ type: 'config:reloaded' }));
    await waitFor(() => expect(result.current.modelSelection).toEqual(A));
    expect(localStorage.length).toBe(0);
  });
  it('serializes saves and blocks sending until the latest choice is saved', async () => {
    const { result } = setup('web:saved');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    const first = deferred<ReturnType<typeof json>>(), second = deferred<ReturnType<typeof json>>();
    fetchMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    let saveA!: Promise<void>, saveB!: Promise<void>;
    await act(async () => { saveA = result.current.setModelSelection(A); });
    await act(async () => { saveB = result.current.setModelSelection(B); });
    expect(result.current.isModelSelectionReady).toBe(false);
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'PUT')).toHaveLength(1);
    await act(async () => { first.resolve(json({})); await saveA; });
    expect(result.current.isModelSelectionReady).toBe(false);
    await act(async () => { second.resolve(json({})); await saveB; });
    expect(result.current.modelSelection).toEqual(B);
    expect(result.current.isModelSelectionReady).toBe(true);
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'PUT').map(([, opts]) => JSON.parse(opts.body).selection)).toEqual([A, B]);
  });
  it('preserves next-turn Auto across refresh while the current turn is busy', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: any) => opts?.method === 'PUT'
      ? json({ error: { code: 'SESSION_BUSY' } }, 409)
      : json(url.startsWith('/api/models?') ? catalog : { saved: A }));
    const first = setup('web:busy');
    await waitFor(() => expect(first.result.current.isModelSelectionReady).toBe(true));
    await act(() => first.result.current.setModelSelection({ mode: 'auto' }));
    first.unmount();
    const { result } = setup('web:busy');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    expect(result.current.modelSelection).toEqual({ mode: 'auto' });
    act(() => listener({ type: 'model-selection-changed', sessionId: 'web:busy', modelProvider: 'alpha', model: 'first', runId: 'run-old' }));
    expect(result.current.modelSelection).toEqual({ mode: 'auto' });
    expect(result.current.runningModels['web:busy'].model).toBe('first');
  });
  it('reports save failures without enabling sending or reverting the choice', async () => {
    const { result } = setup('web:saved');
    await waitFor(() => expect(result.current.isModelSelectionReady).toBe(true));
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Save failed' } }, 500));
    await act(async () => { await expect(result.current.setModelSelection(A)).rejects.toThrow('Save failed'); });
    expect(result.current.modelSelection).toEqual(A);
    expect(result.current.isModelSelectionReady).toBe(false);
  });
});
