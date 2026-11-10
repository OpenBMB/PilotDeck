// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../../../utils/api';
import PythonRuntimeSection from './PythonRuntimeSection';
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const fetchMock = vi.mocked(authenticatedFetch);
const response = (body: object) => ({ ok: true, json: async () => body }) as Response;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it('defaults on, reports the Gateway interpreter, and patches only the preference after saving', async () => {
  fetchMock.mockResolvedValue(response({ state: 'ready', version: '3.12.16', executable: '/gateway/python', packages: { mcp: '1' } }));
  const config = { customEnv: { KEEP: 'value' }, model: { providers: { test: { apiKey: 'preserve' } } } };
  let finish!: (ok: boolean) => void;
  const onSave = vi.fn(() => new Promise<boolean>(done => { finish = done; }));
  render(<PythonRuntimeSection config={config} onSave={onSave} saving={false} />);
  const toggle = screen.getByRole('switch'); expect(toggle.getAttribute('aria-checked')).toBe('true');
  await screen.findByText('/gateway/python');
  fireEvent.click(toggle);
  expect(onSave).toHaveBeenCalledWith({ ...config, runtime: { python: { enabled: false } } });
  expect((toggle as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByText('pythonRuntime.saved')).toBeNull();
  finish(true);
  await screen.findByText('pythonRuntime.saved');
  expect(config).not.toHaveProperty('runtime');
});

it('does not claim success or change the saved toggle when saving fails', async () => {
  fetchMock.mockResolvedValue(response({ state: 'disabled', enabled: false }));
  render(<PythonRuntimeSection config={{ runtime: { python: { enabled: false } } }} onSave={vi.fn().mockResolvedValue(false)} saving={false} />);
  await screen.findByText('pythonRuntime.disabled');
  fireEvent.click(screen.getByRole('switch'));
  await screen.findByText('pythonRuntime.saveFailed');
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByText('pythonRuntime.saved')).toBeNull();
});

it('distinguishes a disconnected Gateway and retries its status without changing settings', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({ state: 'unavailable' }));
  const onSave = vi.fn();
  render(<PythonRuntimeSection config={{}} onSave={onSave} saving={false} />);
  await screen.findByText('pythonRuntime.statusFailed');
  fireEvent.click(screen.getByRole('button', { name: 'pythonRuntime.refresh' }));
  await screen.findByText('pythonRuntime.unavailable');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(onSave).not.toHaveBeenCalled();
});

it('reads lightweight status once and performs full validation only on an explicit check', async () => {
  fetchMock.mockResolvedValue(response({ state: 'available', enabled: true, version: '3.12.16', executable: '/base/python' }));
  render(<PythonRuntimeSection config={{}} onSave={vi.fn()} saving={false} />);
  await screen.findByText('/base/python');
  expect(fetchMock).toHaveBeenCalledWith('/api/config/python-runtime', expect.objectContaining({ method: 'GET' }));
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  fireEvent.click(screen.getByRole('button', { name: 'pythonRuntime.refresh' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/config/python-runtime/check', expect.objectContaining({ method: 'POST' })));
});

it('ends a hung check, enables retry, and ignores a response arriving after timeout', async () => {
  fetchMock.mockResolvedValueOnce(response({ state: 'available', enabled: true }));
  render(<PythonRuntimeSection config={{}} onSave={vi.fn()} saving={false} />);
  await screen.findByText('pythonRuntime.available');
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'pythonRuntime.refresh' }));
  const signal = (fetchMock.mock.calls.at(-1)![1] as RequestInit)?.signal;
  await act(async () => { await vi.advanceTimersByTimeAsync(91_000); });
  expect(signal?.aborted).toBe(true);
  expect(screen.getByText('pythonRuntime.statusTimedOut')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'pythonRuntime.refresh' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => finish(response({ state: 'ready', executable: '/stale/python' })));
  expect(screen.queryByText('/stale/python')).toBeNull();
});

it('aborts its pending request on unmount', () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const view = render(<PythonRuntimeSection config={{}} onSave={vi.fn()} saving={false} />);
  const signal = (fetchMock.mock.calls[0][1] as RequestInit)?.signal;
  view.unmount(); expect(signal?.aborted).toBe(true);
});

it('bounds a metadata read without leaving the settings card checking forever', async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(() => new Promise(() => {}));
  render(<PythonRuntimeSection config={{}} onSave={vi.fn()} saving={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
  expect(screen.getByText('pythonRuntime.statusTimedOut')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'pythonRuntime.refresh' }) as HTMLButtonElement).disabled).toBe(false);
});
