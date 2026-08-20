import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../utils/api';
import { useCodeEditorDocument } from './useCodeEditorDocument';

vi.mock('../../../utils/api', () => ({
  api: {
    readFile: vi.fn(),
    saveFile: vi.fn(),
  },
}));

const file = {
  name: 'important.ts',
  path: '/project/important.ts',
  projectName: '/project',
};

describe('useCodeEditorDocument load failure regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(api.readFile).mockReset();
    vi.mocked(api.saveFile).mockReset();
  });

  it('never saves an empty or error placeholder after a failed load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.readFile).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
    } as Response);
    const { result } = renderHook(() => useCodeEditorDocument({ file }));

    await waitFor(() => expect(result.current.loadError).toContain('503'));
    expect(result.current.content).toBe('');
    await act(async () => result.current.handleSave());

    expect(api.saveFile).not.toHaveBeenCalled();
    expect(result.current.saveError).toContain('failed to load');
  });

  it('reloads cleanly after a transient load failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.readFile)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'const recovered = true;' }),
      } as Response);
    const { result } = renderHook(() => useCodeEditorDocument({ file }));

    await waitFor(() => expect(result.current.loadError).toBe('temporary failure'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.content).toBe('const recovered = true;'));

    expect(result.current.loadError).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });
});
