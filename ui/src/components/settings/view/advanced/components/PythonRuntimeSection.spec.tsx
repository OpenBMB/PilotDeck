// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../../../utils/api';
import PythonRuntimeSection from './PythonRuntimeSection';
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const fetchMock = vi.mocked(authenticatedFetch);
const response = (body: object) => ({ ok: true, json: async () => body }) as Response;
afterEach(() => { cleanup(); vi.resetAllMocks(); });

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
