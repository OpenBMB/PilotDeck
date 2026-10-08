import { useEffect, useRef } from 'react';
import type { DesktopCommand, DesktopMenuState } from '../../../shared/desktopCommands';
import { hasFindShortcutTarget } from '../../contexts/FindShortcutContext';

export function hasBlockingDialog(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], [data-modal-overlay]'))
    .some(element => !element.closest('[hidden], [aria-hidden="true"], [inert]') && getComputedStyle(element).display !== 'none');
}

/** One bridge for menu actions; the shell owns navigation and draft semantics. */
export function useDesktopCommands(options: {
  canNewConversation: boolean;
  hasProject: boolean;
  canFind: boolean;
  sidebarVisible: boolean;
  integrateMacCaption: boolean;
  execute: (command: DesktopCommand) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const bridge = window.pilotdeckDesktop;
    if (!bridge?.onCommand || !bridge.setMenuState) return;
    const root = document.documentElement;
    let lastState = '';
    let sidebar: Element | null = null;
    let frame = 0;
    let disposed = false;
    const state = (): DesktopMenuState => ({
      ready: true, blocked: hasBlockingDialog(),
      canNewConversation: latest.current.canNewConversation,
      hasProject: latest.current.hasProject, canFind: latest.current.canFind && hasFindShortcutTarget(),
      sidebarVisible: latest.current.sidebarVisible,
    });
    const sync = () => {
      if (disposed) return;
      const next = state();
      const serialized = JSON.stringify(next);
      if (serialized !== lastState) {
        lastState = serialized;
        void bridge.setMenuState!(next).catch(error => console.warn('Could not sync desktop menu', error));
      }
      const candidate = document.querySelector('[data-sidebar-v2-root]');
      if (sidebar !== candidate) {
        if (sidebar) resize?.unobserve(sidebar);
        sidebar = candidate;
        if (sidebar) resize?.observe(sidebar);
      }
      const width = sidebar?.getBoundingClientRect().width ?? 0;
      const integrated = bridge.platform === 'darwin' && latest.current.integrateMacCaption && width >= 120;
      if (root.hasAttribute('data-desktop-integrated') !== integrated) root.toggleAttribute('data-desktop-integrated', integrated);
      // Loading and onboarding retain the full-width preload drag region. A
      // rendered toolbar owns its own drag/no-drag regions and pointer input.
      const toolbar = bridge.platform === 'darwin' && Boolean(document.querySelector('.workspace-header, .settings-main > .topbar'));
      if (root.hasAttribute('data-desktop-toolbar') !== toolbar) root.toggleAttribute('data-desktop-toolbar', toolbar);
      const value = `${width}px`;
      if (root.style.getPropertyValue('--desktop-sidebar-width') !== value) root.style.setProperty('--desktop-sidebar-width', value);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const relevant = '[aria-modal="true"], [data-modal-overlay], [data-sidebar-v2-root], .workspace-header, .settings-main > .topbar, [data-file-search-surface], [data-chat-search-surface], [data-chat-history-search]';
    const affectsChrome = (node: Node) => node instanceof Element
      && (node.matches(relevant) || Boolean(node.querySelector(relevant)));
    const observer = new MutationObserver(records => {
      // Streaming message text should not repeatedly measure window chrome.
      if (records.some(record => record.type === 'attributes'
        ? affectsChrome(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(affectsChrome))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'aria-hidden', 'hidden', 'inert', 'class'] });
    const canExecute = (command: DesktopCommand) => {
      const current = state();
      return !current.blocked
        && (command !== 'files' || current.hasProject)
        && (command !== 'new-conversation' || current.canNewConversation)
        && (command !== 'find' || current.canFind);
    };
    const run = (command: DesktopCommand) => {
      // Recheck at delivery: a modal may have opened after the native menu snapshot.
      if (canExecute(command)) latest.current.execute(command);
    };
    const stop = bridge.onCommand(run);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      const modifier = bridge.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.key.toLowerCase() !== 'b') return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (target?.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm')) return;
      if (!canExecute('toggle-sidebar')) return;
      event.preventDefault(); run('toggle-sidebar');
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    window.addEventListener('pilotdeck:refresh-menu', sync);
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame); observer.disconnect(); resize?.disconnect(); stop();
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      window.removeEventListener('pilotdeck:refresh-menu', sync);
      root.removeAttribute('data-desktop-integrated');
      root.removeAttribute('data-desktop-toolbar');
      root.style.removeProperty('--desktop-sidebar-width');
      void bridge.setMenuState!({ ready: false, blocked: false, canNewConversation: false, hasProject: false, canFind: false, sidebarVisible: false }).catch(() => {});
    };
  }, []);
  useEffect(() => { window.dispatchEvent(new Event('pilotdeck:refresh-menu')); }, [
    options.canNewConversation, options.hasProject, options.canFind, options.sidebarVisible, options.integrateMacCaption,
  ]);
}
