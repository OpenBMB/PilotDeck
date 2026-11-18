/**
 * Shared bootstrap for third-party UI page plugins.
 *
 * A plugin entry calls `mountPlugin(container, api, { initialPath, render })`
 * from its exported `mount`, and re-exports `unmountPlugin` as `unmount`.
 * The bootstrap owns the React root, a MemoryRouter (the host app owns the
 * real URL), and the current-user fetch — plugins only provide their tree.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

export type PluginUser = { id: string; username: string; is_admin: boolean };

export type PluginApi = {
  get context(): PluginContextLike;
  onContextChange(cb: (ctx: PluginContextLike) => void): () => void;
};

export type PluginContextLike = {
  theme?: 'dark' | 'light';
  language?: 'zh-CN' | 'en';
  project?: { name: string; path: string } | null;
  session?: { id: string; title: string } | null;
};

type MountOptions = {
  initialPath: string;
  render: (user: PluginUser | undefined, api: PluginApi) => React.ReactNode;
};

const roots = new WeakMap<HTMLElement, Root>();

function usePluginUser(api: PluginApi): PluginUser | undefined {
  const [user, setUser] = React.useState<PluginUser | undefined>(undefined);
  const [, forceUpdate] = React.useReducer((tick: number) => tick + 1, 0);

  React.useEffect(() => api.onContextChange(() => forceUpdate()), [api]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/user', { credentials: 'same-origin' });
        const body = res.ok ? await res.json() : null;
        const u = body?.user;
        if (cancelled) return;
        setUser(u
          ? { id: String(u.id ?? ''), username: String(u.username ?? ''), is_admin: u.is_admin === true }
          : undefined);
      } catch {
        if (!cancelled) setUser(undefined);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return user;
}

function PluginRoot({ api, options }: { api: PluginApi; options: MountOptions }) {
  const user = usePluginUser(api);
  return <MemoryRouter initialEntries={[options.initialPath]}>{options.render(user, api)}</MemoryRouter>;
}

export function mountPlugin(container: HTMLElement, api: PluginApi, opts: MountOptions): () => void {
  const inner = document.createElement('div');
  inner.style.height = '100%';
  inner.style.width = '100%';
  container.replaceChildren(inner);

  const root = createRoot(inner);
  roots.set(container, root);
  root.render(<PluginRoot api={api} options={opts} />);

  return () => unmountPlugin(container);
}

export function unmountPlugin(container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    roots.delete(container);
    try { root.unmount(); } catch { /* already unmounted */ }
  }
  container.replaceChildren();
}
