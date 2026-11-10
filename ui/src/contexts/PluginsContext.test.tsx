import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginsProvider, usePlugins } from './PluginsContext';
import { authenticatedFetch } from '../utils/api';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const plugin = { name: 'fixture', version: '1', entry: 'index.js', enabled: true };
beforeEach(() => {
  vi.mocked(authenticatedFetch).mockImplementation(async url => new Response(JSON.stringify(String(url) === '/api/plugins' ? { plugins: [plugin] } : { success: true })));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('invalidates the mounted plugin after successful update even when its manifest version is unchanged', async () => {
  const { result } = renderHook(usePlugins, { wrapper: PluginsProvider });
  await waitFor(() => expect(result.current.plugins).toHaveLength(1));
  await act(async () => { expect(await result.current.updatePlugin('fixture')).toEqual({ success: true }); });
  expect(result.current.plugins[0].version).toBe('1');
  expect(result.current.pluginRevisions?.fixture).toBe(1);
  await act(async () => { await result.current.refreshPlugins(); });
  expect(result.current.pluginRevisions?.fixture).toBe(1);
});

it('does not invalidate a plugin when its update fails', async () => {
  const { result } = renderHook(usePlugins, { wrapper: PluginsProvider });
  await waitFor(() => expect(result.current.plugins).toHaveLength(1));
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Update failed' }), { status: 503 }));
  await act(async () => { expect((await result.current.updatePlugin('fixture')).success).toBe(false); });
  expect(result.current.pluginRevisions?.fixture).toBeUndefined();
});
