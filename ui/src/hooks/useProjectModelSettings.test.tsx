// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../utils/api';
import { useProjectModelSettings, type ProjectModelSettingsResponse } from './useProjectModelSettings';

vi.mock('../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

const fetchMock = vi.mocked(authenticatedFetch);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function responseFor(projectKey: string, mainModel: string) {
  const payload: ProjectModelSettingsResponse = {
    projectKey,
    configPath: `/tmp/${projectKey}/.pilotdeck/pilotdeck.yaml`,
    exists: true,
    inherited: {},
    settings: { mainModel },
    effective: { mainModel },
    modelOptions: [],
    diagnostics: [],
  };

  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useProjectModelSettings', () => {
  it('ignores stale loads when switching projects quickly', async () => {
    const alpha = deferred<Response>();
    const beta = deferred<Response>();

    fetchMock.mockImplementation((url) => {
      const text = String(url);
      if (text.includes('/alpha/')) return alpha.promise;
      if (text.includes('/beta/')) return beta.promise;
      throw new Error(`Unexpected URL: ${text}`);
    });

    const { result, rerender } = renderHook(
      ({ projectName }) => useProjectModelSettings(projectName),
      { initialProps: { projectName: 'alpha' } },
    );

    rerender({ projectName: 'beta' });
    beta.resolve(responseFor('beta', 'openai/beta'));

    await waitFor(() => {
      expect(result.current.data?.projectKey).toBe('beta');
      expect(result.current.draft.mainModel).toBe('openai/beta');
    });

    alpha.resolve(responseFor('alpha', 'openai/alpha'));

    await waitFor(() => {
      expect(result.current.data?.projectKey).toBe('beta');
      expect(result.current.draft.mainModel).toBe('openai/beta');
    });
  });

  it('clears stale settings when no project is selected', async () => {
    fetchMock.mockResolvedValue(responseFor('alpha', 'openai/alpha'));

    const { result, rerender } = renderHook(
      ({ projectName }: { projectName?: string }) => useProjectModelSettings(projectName),
      { initialProps: { projectName: 'alpha' } },
    );

    await waitFor(() => {
      expect(result.current.data?.projectKey).toBe('alpha');
    });

    rerender({ projectName: undefined });

    await waitFor(() => {
      expect(result.current.data).toBeNull();
      expect(result.current.draft).toEqual({});
      expect(result.current.loading).toBe(false);
    });
  });

  it('ignores stale loads that finish after a save', async () => {
    const slowLoad = deferred<Response>();

    fetchMock.mockImplementation((url, options) => {
      if (String(url).includes('/alpha/') && options?.method === 'PUT') {
        return Promise.resolve(responseFor('alpha', 'openai/saved'));
      }
      if (String(url).includes('/alpha/')) {
        return slowLoad.promise;
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });

    const { result } = renderHook(
      ({ projectName }: { projectName?: string }) => useProjectModelSettings(projectName),
      { initialProps: { projectName: 'alpha' } },
    );

    act(() => {
      result.current.setDraft({ mainModel: 'openai/saved' });
    });

    let saveResult = false;
    await act(async () => {
      saveResult = await result.current.save();
    });

    await waitFor(() => {
      expect(saveResult).toBe(true);
      expect(result.current.data?.settings.mainModel).toBe('openai/saved');
      expect(result.current.message).toBe('Saved for this project');
    });

    slowLoad.resolve(responseFor('alpha', 'openai/stale'));

    await waitFor(() => {
      expect(result.current.data?.settings.mainModel).toBe('openai/saved');
      expect(result.current.draft.mainModel).toBe('openai/saved');
    });
  });

  it('returns false and keeps the draft when save fails', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (String(url).includes('/alpha/') && options?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: 'Project model settings are invalid' }),
        } as Response);
      }
      return Promise.resolve(responseFor('alpha', 'openai/alpha'));
    });

    const { result } = renderHook(
      ({ projectName }: { projectName?: string }) => useProjectModelSettings(projectName),
      { initialProps: { projectName: 'alpha' } },
    );

    await waitFor(() => {
      expect(result.current.data?.projectKey).toBe('alpha');
    });

    act(() => {
      result.current.setDraft({ mainModel: 'openai/invalid' });
    });

    let saveResult = true;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult).toBe(false);
    expect(result.current.error).toBe('Project model settings are invalid');
    expect(result.current.draft.mainModel).toBe('openai/invalid');
  });
});
