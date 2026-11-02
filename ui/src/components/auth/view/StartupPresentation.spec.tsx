// @vitest-environment jsdom
import { I18nextProvider } from 'react-i18next';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import AuthLoadingScreen from './AuthLoadingScreen';
import StartupErrorPanel from './StartupErrorPanel';
import StartupReady from './StartupReady';
import { startupVisualProgress } from '../../../../../apps/desktop/src/startupPresentation';

afterEach(() => { cleanup(); vi.useRealTimers(); delete window.pilotdeckDesktop; delete window.__pilotdeckStartupState; });

it('moves slowly inside a stage, remains bounded and resumes at the same position after handoff', () => {
  const status = { phase: 'gateway', progress: 78, phaseStartedAt: 1000 };
  const first = startupVisualProgress(status, 2000), later = startupVisualProgress(status, 20000);
  expect(later).toBeGreaterThan(first); expect(later).toBeLessThan(94);
  expect(startupVisualProgress({ ...status }, 20000)).toBe(later);
  expect(startupVisualProgress(status, 10000000)).toBeLessThanOrEqual(94);
});

it('finishes and fades smoothly even when a client is ready immediately', async () => {
  const i18n = await createTestI18n();
  vi.useFakeTimers();
  window.__pilotdeckStartupState = { phase: 'starting', progress: 8, startedAt: Date.now(), phaseStartedAt: Date.now() };
  render(<I18nextProvider i18n={i18n}><StartupReady><div>workspace ready</div></StartupReady></I18nextProvider>);
  expect(screen.getByText('workspace ready').closest('[aria-hidden=true]')).toBeTruthy();
  expect(screen.queryByText('P')).toBeNull();
  act(() => vi.advanceTimersByTime(650));
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  act(() => vi.advanceTimersByTime(240));
  expect(document.querySelector('[data-leaving=true]')).toBeTruthy();
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByText('workspace ready')).toBeTruthy();
  expect(screen.getByText('workspace ready').closest('[aria-hidden=true]')).toBeNull();
});

it('never restarts the progress bar when a browser Gateway finishes loading', async () => {
  const i18n = await createTestI18n();
  window.__pilotdeckStartupState = { phase: 'gateway', progress: 78, startedAt: Date.now() - 5000, phaseStartedAt: Date.now() - 3000 };
  const view = render(<I18nextProvider i18n={i18n}><AuthLoadingScreen gateway /></I18nextProvider>);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('78');
  view.rerender(<I18nextProvider i18n={i18n}><AuthLoadingScreen finishing /></I18nextProvider>);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('96');
});

it('continues desktop progress after navigation and updates without showing internal details', async () => {
  let listener: (value: object) => void = () => {};
  Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: {
    getRuntimeStatus: () => ({ phase: 'gateway', progress: 78, logPath: '/private/path', message: 'technical detail' }),
    onRuntimeStatus: (callback: typeof listener) => { listener = callback; return vi.fn(); },
  } });
  const i18n = await createTestI18n();
  render(<I18nextProvider i18n={i18n}><AuthLoadingScreen /></I18nextProvider>);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('78');
  expect(screen.queryByText(/private|technical/)).toBeNull();
  act(() => listener({ phase: 'ready', progress: 96 }));
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('96');
  expect(screen.getByText('Opening your workspace…')).toBeTruthy();
});

it.each([
  ['PD_RUNTIME_OUT_OF_MEMORY', 'There was not enough memory to start the service.'],
  ['PD_RESOURCE_NOT_FOUND', 'A required application file is missing. Reinstall PilotDeck and try again.'],
  ['PD_NETWORK_PORT_IN_USE', 'A port required by the local service is already in use.'],
])('shows a concise reason for %s and delegates save/cancel to the native dialog', async (code, reason) => {
  const saveRuntimeLogs = vi.fn().mockResolvedValue({ canceled: true }), retry = vi.fn();
  Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: { saveRuntimeLogs } });
  const i18n = await createTestI18n();
  render(<I18nextProvider i18n={i18n}><StartupErrorPanel error={`Error code: ${code}\nsecret-stack-details\nRuntime log: C:\\logs\\runtime.log`} onRetry={retry} /></I18nextProvider>);
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.queryByText(/secret-stack-details/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Restart' })); expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime logs' }));
  await waitFor(() => expect(saveRuntimeLogs).toHaveBeenCalledOnce());
  expect(screen.queryByText('Runtime logs saved')).toBeNull();
});

it('reports a native save failure without closing the error screen', async () => {
  Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: { saveRuntimeLogs: vi.fn().mockRejectedValue(new Error('EACCES')) } });
  const i18n = await createTestI18n();
  render(<I18nextProvider i18n={i18n}><StartupErrorPanel error="code=134 signal=null" onRetry={vi.fn()} /></I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime logs' }));
  expect(await screen.findByText('Could not save the logs. Try another location.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
});
