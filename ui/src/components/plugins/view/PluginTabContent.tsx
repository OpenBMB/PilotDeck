import { useEffect, useRef } from 'react';
import { useTheme } from '../../../contexts/ThemeContext';
import { authenticatedFetch } from '../../../utils/api';
import { usePlugins } from '../../../contexts/PluginsContext';
import type { Project, ProjectSession } from '../../../types/app';

type PluginTabContentProps = {
  pluginName: string;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
};

type PluginContext = {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

function buildContext(
  isDarkMode: boolean,
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): PluginContext {
  return {
    theme: isDarkMode ? 'dark' : 'light',
    project: selectedProject
      ? {
        name: selectedProject.name,
        path: selectedProject.fullPath || selectedProject.path || '',
      }
      : null,
    session: selectedSession
      ? {
        id: selectedSession.id,
        title: selectedSession.title || selectedSession.name || selectedSession.id,
      }
      : null,
  };
}

export default function PluginTabContent({
  pluginName,
  selectedProject,
  selectedSession,
}: PluginTabContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isDarkMode } = useTheme();
  const { plugins, pluginRevisions } = usePlugins();

  // Stable refs so effects don't need context values in their dep arrays
  const contextRef = useRef<PluginContext>(buildContext(isDarkMode, selectedProject, selectedSession));
  const contextCallbacksRef = useRef<Set<(ctx: PluginContext) => void>>(new Set());

  const plugin = plugins.find(p => p.name === pluginName);
  const pluginRevision = pluginRevisions?.[pluginName] ?? 0;

  // Keep contextRef current and notify the mounted plugin on every context change
  useEffect(() => {
    const ctx = buildContext(isDarkMode, selectedProject, selectedSession);
    contextRef.current = ctx;

    for (const cb of contextCallbacksRef.current) {
      try { cb(ctx); } catch { /* plugin error — ignore */ }
    }
  }, [isDarkMode, selectedProject, selectedSession]);

  useEffect(() => {
    if (!containerRef.current || !plugin?.enabled) return;

    let active = true;
    const abort = new AbortController();
    const host = containerRef.current;
    // Each mount owns a detached-on-cleanup container. A late asynchronous
    // mount/unmount can never mutate the next plugin's live DOM.
    const container = document.createElement('div');
    container.className = 'h-full w-full';
    host.replaceChildren(container);
    const entryFile = plugin?.entry ?? 'index.js';
    const contextCallbacks = new Set<(ctx: PluginContext) => void>();
    contextCallbacksRef.current = contextCallbacks;
    let unmount: (() => unknown) | null = null;
    let errorElement: HTMLElement | null = null;
    let mountSettled = false;
    const dispose = () => {
      if (!mountSettled || !unmount) return;
      const cleanup = unmount;
      unmount = null;
      try { void Promise.resolve(cleanup()).catch(() => {}); } catch { /* plugin error — ignore */ }
    };

    (async () => {
      try {
        // Fetch the plugin JS with auth headers (Cloudflare Worker requires auth on all routes).
        // Then import it via a Blob URL so the browser never makes an unauthenticated request.
        const assetUrl = `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(entryFile)}`;
        const res = await authenticatedFetch(assetUrl, { signal: abort.signal });
        if (!res.ok) throw new Error(`Failed to fetch plugin (HTTP ${res.status})`);
        const jsText = await res.text();
        const blob = new Blob([jsText], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        // @vite-ignore
        const mod = await import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
        if (!active) return;
        unmount = () => mod.unmount?.(container);

        const api = {
          get context(): PluginContext { return contextRef.current; },
          signal: abort.signal,

          onContextChange(cb: (ctx: PluginContext) => void): () => void {
            if (!active) return () => {};
            contextCallbacks.add(cb);
            return () => contextCallbacks.delete(cb);
          },

          async rpc(method: string, path: string, body?: unknown): Promise<unknown> {
            abort.signal.throwIfAborted();
            const cleanPath = String(path).replace(/^\//, '');
            const res = await authenticatedFetch(
              `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${cleanPath}`,
              {
                method: method || 'GET',
                signal: abort.signal,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
              },
            );
            if (!res.ok) throw new Error(`RPC error ${res.status}`);
            return res.json();
          },
        };

        try { await mod.mount?.(container, api); }
        finally { mountSettled = true; if (!active) dispose(); }
      } catch (err) {
        if (!active) return;
        active = false;
        abort.abort();
        container.remove();
        dispose();
        contextCallbacks.clear();
        console.error(`[Plugin:${pluginName}] Failed to load:`, err);
        const errDiv = document.createElement('div');
        errDiv.className = 'p-4 text-sm text-destructive';
        errDiv.setAttribute('role', 'alert');
        errDiv.textContent = `Plugin failed to load: ${String(err)}`;
        errorElement = errDiv;
        host.append(errDiv);
      }
    })();

    return () => {
      active = false;
      abort.abort();
      contextCallbacks.clear();
      if (contextCallbacksRef.current === contextCallbacks) contextCallbacksRef.current = new Set();
      container.remove();
      errorElement?.remove();
      dispose();
    };
  }, [pluginName, plugin?.entry, plugin?.enabled, plugin?.version, pluginRevision]);

  return <div ref={containerRef} className="h-full w-full overflow-auto" />;
}
