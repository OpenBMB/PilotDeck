import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PluginTabContent from './PluginTabContent';
import { authenticatedFetch } from '../../../utils/api';

const state = vi.hoisted(() => ({ plugins: [
  { name: 'alpha', entry: 'index.js', version: '1', enabled: true },
  { name: 'beta', entry: 'index.js', version: '1', enabled: true },
], pluginRevisions: {} as Record<string, number> }));
vi.mock('../../../contexts/PluginsContext', () => ({ usePlugins: () => state }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
type Mount = { name: string; container: HTMLElement; api: { signal: AbortSignal; rpc: (method: string, path: string) => Promise<unknown> } };
type Fixture = { mounts: Mount[]; unmounts: string[]; contextEvents: string[]; pauseAlpha?: Promise<void>; failAlpha?: boolean; pauseUnmount?: Promise<void> };
let fixture: Fixture;
let modules: string[];
const moduleSource = (name: string) => `
export async function mount(container, api) {
  const fixture = container.ownerDocument.defaultView.__pluginFixture;
  fixture.mounts.push({ name: '${name}', container, api });
  container.textContent = '${name} content';
  if ('${name}' === 'alpha' && fixture.pauseAlpha) await fixture.pauseAlpha;
  api.onContextChange(() => fixture.contextEvents.push('${name}'));
  if ('${name}' === 'alpha' && fixture.failAlpha) throw new Error('Synthetic mount failure');
}
export async function unmount(container) {
  const fixture = container.ownerDocument.defaultView.__pluginFixture;
  fixture.unmounts.push('${name}');
  if (fixture.pauseUnmount) await fixture.pauseUnmount;
  container.replaceChildren();
}`;
const props = { pluginName: 'alpha', selectedProject: null, selectedSession: null };
beforeEach(() => {
  fixture = { mounts: [], unmounts: [], contextEvents: [] };
  (window as unknown as { __pluginFixture: Fixture }).__pluginFixture = fixture;
  modules = [];
  state.plugins.forEach(plugin => { plugin.version = '1'; plugin.enabled = true; });
  state.pluginRevisions = {};
  vi.mocked(authenticatedFetch).mockImplementation(async url => {
    if (String(url).includes('/assets/')) {
      const source = moduleSource(String(url).includes('/alpha/') ? 'alpha' : 'beta');
      modules.push(source);
      return new Response(source);
    }
    return new Response('{}');
  });
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return `data:text/javascript,${encodeURIComponent(modules.shift()!)}`; }
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('isolates a late async mount and cleanup from the next plugin and its subscriptions', async () => {
  let finish!: () => void;
  fixture.pauseAlpha = new Promise(resolve => { finish = resolve; });
  const view = render(<PluginTabContent {...props} />);
  await waitFor(() => expect(fixture.mounts).toHaveLength(1));
  view.rerender(<PluginTabContent {...props} pluginName="beta" />);
  await waitFor(() => expect(screen.getByText('beta content')).toBeTruthy());
  await act(async () => { finish(); await fixture.pauseAlpha; });
  expect(screen.getByText('beta content')).toBeTruthy();
  expect(fixture.unmounts).toEqual(['alpha']);
  expect(fixture.mounts[0].container.isConnected).toBe(false);
  expect(fixture.mounts[0].api.signal.aborted).toBe(true);
  view.rerender(<PluginTabContent {...props} pluginName="beta" selectedSession={{ id: 'session-b' }} />);
  expect(fixture.contextEvents).toEqual(['beta']);
  view.unmount();
  expect(fixture.unmounts).toEqual(['alpha', 'beta']);
});

it.each(['version', 'revision'] as const)('reloads the active plugin when its %s changes', async kind => {
  const view = render(<PluginTabContent {...props} />);
  await waitFor(() => expect(fixture.mounts).toHaveLength(1));
  if (kind === 'version') state.plugins[0].version = '2';
  else state.pluginRevisions.alpha = 1;
  view.rerender(<PluginTabContent {...props} />);
  await waitFor(() => expect(fixture.mounts).toHaveLength(2));
  expect(fixture.unmounts).toEqual(['alpha']);
  expect(fixture.mounts[0].container).not.toBe(fixture.mounts[1].container);
  expect(screen.getByText('alpha content')).toBeTruthy();
});

it('cleans an asynchronous mount after disable and prevents its RPC from reaching the server', async () => {
  let finish!: () => void;
  fixture.pauseAlpha = new Promise(resolve => { finish = resolve; });
  const view = render(<PluginTabContent {...props} />);
  await waitFor(() => expect(fixture.mounts).toHaveLength(1));
  state.plugins[0].enabled = false;
  view.rerender(<PluginTabContent {...props} />);
  expect(view.container.textContent).toBe('');
  await act(async () => { finish(); await fixture.pauseAlpha; });
  expect(fixture.unmounts).toEqual(['alpha']);
  const requests = vi.mocked(authenticatedFetch).mock.calls.length;
  await expect(fixture.mounts[0].api.rpc('POST', '/write')).rejects.toBeTruthy();
  expect(authenticatedFetch).toHaveBeenCalledTimes(requests);
});

it('cleans a failed mount once and renders an accessible loading error', async () => {
  fixture.failAlpha = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const view = render(<PluginTabContent {...props} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Synthetic mount failure'));
  expect(fixture.unmounts).toEqual(['alpha']);
  view.unmount();
  expect(fixture.unmounts).toEqual(['alpha']);
});

it('keeps the host error visible after a failed module finishes asynchronous cleanup', async () => {
  fixture.failAlpha = true;
  let finish!: () => void;
  fixture.pauseUnmount = new Promise(resolve => { finish = resolve; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<PluginTabContent {...props} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Synthetic mount failure'));
  await act(async () => { finish(); await fixture.pauseUnmount; });
  expect(screen.getByRole('alert').textContent).toContain('Synthetic mount failure');
  expect(fixture.unmounts).toEqual(['alpha']);
});
