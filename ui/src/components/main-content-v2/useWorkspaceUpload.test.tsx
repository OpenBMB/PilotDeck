import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceUpload } from './useWorkspaceUpload';
const mocks = vi.hoisted(() => ({ limits: vi.fn(), check: vi.fn(), upload: vi.fn(), t: (key: string) => key }));
vi.mock('../../utils/api', () => ({ api: { uploadLimits: mocks.limits, uploadFiles: mocks.upload, checkWorkspaceUpload: mocks.check } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
const limits = { maxFiles: 500, maxFileBytes: 1024 ** 3, maxTaskBytes: 2 * 1024 ** 3 };
beforeEach(() => { mocks.limits.mockReset().mockResolvedValue({ ok: true, json: async () => limits }); mocks.upload.mockReset(); mocks.check.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }); });
afterEach(cleanup);
const file = (name: string) => new File(['hello'], name);
const success = (files: File[]) => ({ ok: true, body: { files: files.map(f => ({ name: f.name, size: f.size })), errors: [] } });
describe('workspace upload state', () => {
  it('keeps transfer completion in the saving state until the server confirms success', async () => {
    let finish!: (value: unknown) => void;
    mocks.upload.mockImplementation((_project, _form, options) => {
      options.onProgress(100); options.onTransferred();
      return new Promise(resolve => { finish = resolve; });
    });
    const refresh = vi.fn();
    const { result } = renderHook(() => useWorkspaceUpload('project', refresh));
    const files = [file('slides.pptx')];
    act(() => { void result.current.start(files); });
    await waitFor(() => expect(result.current.upload?.stage).toBe('saving'));
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { finish(success(files)); });
    expect(result.current.upload?.stage).toBe('completed'); expect(refresh).toHaveBeenCalledOnce();
  });
  it('rejects an oversized batch before any file bytes are sent', async () => {
    mocks.limits.mockResolvedValue({ ok: true, json: async () => ({ ...limits, maxFileBytes: 1 }) });
    const { result } = renderHook(() => useWorkspaceUpload('project', vi.fn()));
    await act(async () => { await result.current.start([file('a.txt')]); });
    expect(result.current.upload?.stage).toBe('failed'); expect(result.current.upload?.retryFiles).toEqual([]);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('does not send file contents when preflight finds an existing destination', async () => {
    mocks.check.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: 'UPLOAD_FILE_EXISTS' }, conflicts: ['a.txt'] }) });
    const { result } = renderHook(() => useWorkspaceUpload('project', vi.fn()));
    await act(async () => { await result.current.start([file('a.txt')], 'docs'); });
    expect(mocks.check).toHaveBeenCalledWith('project', { targetPath: 'docs', relativePaths: ['a.txt'] }, expect.any(AbortSignal));
    expect(result.current.upload).toMatchObject({ stage: 'failed', uploadedBytes: 0, retryFiles: [], errorCode: 'UPLOAD_FILE_EXISTS', error: 'fileTree.uploadStatus.fileExists' });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('shows a late name conflict as a failure and excludes it from retry', async () => {
    mocks.upload.mockResolvedValue({ ok: true, body: { files: [], errors: [{ name: 'a.txt', code: 'UPLOAD_FILE_EXISTS', message: 'exists' }] } });
    const refresh = vi.fn();
    const { result } = renderHook(() => useWorkspaceUpload('project', refresh));
    await act(async () => { await result.current.start([file('a.txt')]); });
    expect(result.current.upload).toMatchObject({ stage: 'failed', retryFiles: [], errorCode: 'UPLOAD_FILE_EXISTS', error: 'fileTree.uploadStatus.fileExists' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('retries only failed files in their original target directory', async () => {
    const a = file('a.txt'); const b = file('b.txt');
    mocks.upload.mockResolvedValueOnce({ ok: true, body: { files: [{ name: 'a.txt', size: 5 }], errors: [{ name: 'b.txt', message: 'denied' }] } }).mockResolvedValueOnce(success([b]));
    const { result } = renderHook(() => useWorkspaceUpload('project', vi.fn()));
    await act(async () => { await result.current.start([a, b], 'docs'); });
    expect(result.current.upload?.retryFiles).toEqual([b]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.upload?.stage).toBe('completed'));
    const form = mocks.upload.mock.calls[1][1] as FormData;
    expect(form.get('targetPath')).toBe('docs'); expect(form.getAll('files')).toEqual([b]);
  });
  it('guards duplicate drops and discards late results after changing projects', async () => {
    let finish!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const refresh = vi.fn();
    const { result, rerender } = renderHook(({ project }) => useWorkspaceUpload(project, refresh), { initialProps: { project: 'one' } });
    act(() => { void result.current.start([file('a.txt')]); void result.current.start([file('b.txt')]); });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const signal = mocks.upload.mock.calls[0][2].signal;
    rerender({ project: 'two' });
    expect(signal.aborted).toBe(true);
    await act(async () => finish(success([file('a.txt')])));
    expect(result.current.upload).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  });
  it('shows cancellation and permits retry after a network error', async () => {
    mocks.upload.mockImplementationOnce((_project, _form, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
      .mockRejectedValueOnce(new Error('UPLOAD_NETWORK_ERROR'));
    const { result } = renderHook(() => useWorkspaceUpload('project', vi.fn()));
    act(() => { void result.current.start([file('a.txt')]); });
    await waitFor(() => expect(result.current.upload?.stage).toBe('uploading'));
    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.upload?.stage).toBe('cancelled'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.upload?.error).toBe('fileTree.uploadStatus.networkError'));
  });
});
