// @vitest-environment jsdom
import { I18nextProvider } from 'react-i18next';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import AuthLoadingScreen from './AuthLoadingScreen';
import StartupErrorPanel from './StartupErrorPanel';
import StartupReady from './StartupReady';
import { startupVisualProgress } from '../../../../../apps/desktop/src/startupPresentation';
import { renderLoadingHtml } from '../../../../../apps/desktop/src/appearance';
import { releaseStartupShell } from '../startupShell';

afterEach(() => { cleanup(); document.getElementById('root')?.remove(); releaseStartupShell(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.pilotdeckDesktop; delete window.__pilotdeckStartupState; });

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
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  render(<I18nextProvider i18n={i18n}><StartupReady><main className="desktop-prototype-shell">workspace ready</main></StartupReady></I18nextProvider>, { container: root });
  const workspace = screen.getByText('workspace ready');
  expect(workspace.parentElement).toBe(root);
  expect(root.inert).toBe(true);
  expect(root.dataset.pilotdeckStartup).toBe('complete');
  expect(screen.queryByText('P')).toBeNull();
  expect(workspace.parentElement).toBe(root);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  act(() => vi.advanceTimersByTime(240));
  expect(document.querySelector('[data-leaving=true]')).toBeTruthy();
  act(() => vi.advanceTimersByTime(180));
  expect(screen.getByText('workspace ready')).toBeTruthy();
  expect(screen.getByText('workspace ready')).toBe(workspace);
  expect(workspace.parentElement).toBe(root);
  expect(root.inert).toBe(false);
  expect(root.dataset.pilotdeckStartup).toBeUndefined();
});

it.each([
  [undefined, '#ffffff'],
  [{ preset: 'default' }, '#ffffff'],
  [{ preset: 'lavender' }, '#eeebf3'],
  [{ preset: 'custom', custom: { background: '#b9dfce' } }, '#b9dfce'],
])('keeps the native startup canvas during the Web handoff with preference %j', (lightAppearance, expected) => {
  // Reproduce the default lavender application canvas being available before
  // the Web startup script runs, after leaving the native white document.
  document.documentElement.style.backgroundColor = '#eef0f8';
  localStorage.setItem('themeMode', 'light');
  localStorage.setItem('pilotdeck-light-appearance-v1', JSON.stringify(lightAppearance ?? null));
  const html = renderLoadingHtml({ language: 'en', themeMode: 'light' }, true);
  const shell = document.createElement('div'); shell.id = 'pilotdeck-startup-shell';
  shell.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]; document.body.append(shell);
  try {
    for (const script of shell.querySelectorAll('script')) new Function('window', 'document', 'navigator', 'localStorage', script.textContent!)(window, document, navigator, localStorage);
    expect(document.documentElement.style.getPropertyValue('--startup-bg') || '#ffffff').toBe(expected);
  } finally {
    localStorage.clear(); document.documentElement.removeAttribute('style');
  }
});

it('seeds desktop progress before enabling the first Web transition', () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const status = { phase: 'gateway', progress: 78, startedAt: now - 10000, phaseStartedAt: now - 5000 };
  window.pilotdeckDesktop = { getRuntimeStatus: () => status, onRuntimeStatus: () => () => {} } as never;
  const html = renderLoadingHtml({ language: 'en', themeMode: 'light' }, true);
  const shell = document.createElement('div'); shell.id = 'pilotdeck-startup-shell';
  shell.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]; document.body.append(shell);
  const bar = document.getElementById('bar')!;
  let seededWidth = 0;
  vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => {
    expect(bar.style.transition).toBe('none');
    seededWidth = parseFloat(bar.style.width);
    return {} as DOMRect;
  });
  for (const script of shell.querySelectorAll('script')) new Function('window', 'document', 'navigator', 'localStorage', script.textContent!)(window, document, navigator, localStorage);
  expect(seededWidth).toBeCloseTo(startupVisualProgress(status, now), 1);
  expect(seededWidth).toBeGreaterThan(78);
  expect(bar.style.transition).toBe('');
  window.__pilotdeckStartupUpdate!({ phase: 'ready', progress: 96, completed: true, leaving: true });
  window.__pilotdeckStartupUpdate!({ phase: 'ready', progress: 96 });
  expect(bar.style.width).toBe('100%');
  expect(document.getElementById('startup')!.dataset.leaving).toBe('true');
});

it.each(['dark', 'system'] as const)('keeps dark startup colors with a custom light palette in %s mode', (themeMode) => {
  window.pilotdeckDesktop = { getAppearance: () => ({ themeMode, lightAppearance: { preset: 'rose' } }), onRuntimeStatus: () => () => {} } as never;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const html = renderLoadingHtml({ language: 'en', themeMode }, true);
  const shell = document.createElement('div'); shell.id = 'pilotdeck-startup-shell';
  shell.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]; document.body.append(shell);
  try {
    for (const script of shell.querySelectorAll('script')) new Function('window', 'document', 'navigator', 'localStorage', script.textContent!)(window, document, navigator, localStorage);
    expect(document.documentElement.style.getPropertyValue('--startup-bg')).toBe('#0a0a0a');
  } finally { vi.unstubAllGlobals(); document.documentElement.removeAttribute('style'); }
});

it('keeps the same painted HTML shell and progress node through React loading, Gateway and workspace handoffs', async () => {
  const i18n = await createTestI18n();
  vi.useFakeTimers();
  const html = renderLoadingHtml({ language: 'en', themeMode: 'light' }, true);
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1];
  const shell = document.createElement('div'); shell.id = 'pilotdeck-startup-shell';
  shell.innerHTML = body; document.body.append(shell);
  for (const script of shell.querySelectorAll('script')) new Function('window', 'document', 'navigator', 'localStorage', 'getComputedStyle', script.textContent!)(window, document, navigator, localStorage, getComputedStyle);
  const bar = document.getElementById('bar')!, brand = shell.querySelector('h1')!;
  window.__pilotdeckStartupState!.startedAt = Date.now() - 2000;
  const loading = render(<I18nextProvider i18n={i18n}><AuthLoadingScreen /></I18nextProvider>);
  loading.rerender(<I18nextProvider i18n={i18n}><AuthLoadingScreen gateway /></I18nextProvider>);
  expect(document.getElementById('bar')).toBe(bar);
  expect(shell.querySelectorAll('.pd-startup-brand')).toHaveLength(1);
  expect(bar.parentElement!.getAttribute('aria-valuenow')).toBe('78');
  loading.unmount();
  render(<I18nextProvider i18n={i18n}><StartupReady><div>ready workspace</div></StartupReady></I18nextProvider>);
  act(() => vi.advanceTimersByTime(0));
  expect(document.getElementById('bar')).toBe(bar); expect(brand.isConnected).toBe(true);
  expect(bar.style.width).toBe('100%');
  act(() => vi.advanceTimersByTime(240));
  expect(document.getElementById('startup')!.dataset.leaving).toBe('true');
  act(() => vi.advanceTimersByTime(180));
  expect(document.getElementById('pilotdeck-startup-shell')).toBeNull();
  expect(screen.getByText('ready workspace').closest('[aria-hidden=true]')).toBeNull();
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
  fireEvent.click(screen.getByRole('button', { name: 'Download runtime logs' }));
  await waitFor(() => expect(saveRuntimeLogs).toHaveBeenCalledOnce());
  expect(screen.queryByText('Runtime logs downloaded')).toBeNull();
});

it('reports a native save failure without closing the error screen', async () => {
  Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: { saveRuntimeLogs: vi.fn().mockRejectedValue(new Error('EACCES')) } });
  const i18n = await createTestI18n();
  render(<I18nextProvider i18n={i18n}><StartupErrorPanel error="code=134 signal=null" onRetry={vi.fn()} /></I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Download runtime logs' }));
  expect(await screen.findByText('Could not download the logs. Try another location.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
});
