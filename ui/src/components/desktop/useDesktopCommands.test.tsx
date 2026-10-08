import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopCommand } from '../../../shared/desktopCommands';
import { FindShortcutProvider, useRegisterFindShortcutTarget } from '../../contexts/FindShortcutContext';
import { useDesktopCommands } from './useDesktopCommands';

afterEach(() => { cleanup(); delete window.pilotdeckDesktop; });
it('hands Mac hit testing to mounted toolbars and restores preload ownership on onboarding and unmount', async () => {
  window.pilotdeckDesktop = { platform: 'darwin', setMenuState: vi.fn().mockResolvedValue(undefined), onCommand: () => () => {} } as any;
  function Shell({ surface = 'main' }) {
    useDesktopCommands({ canNewConversation: true, hasProject: true, canFind: true, sidebarVisible: true, integrateMacCaption: true, execute: () => {} });
    return surface === 'main' ? <header className="workspace-header" />
      : surface === 'settings' ? <main className="settings-main"><header className="topbar" /></main>
      : <main className="onboarding-shell" />;
  }
  const root = document.documentElement;
  const view = render(<Shell />);
  expect(root.hasAttribute('data-desktop-toolbar')).toBe(true);
  view.rerender(<Shell surface="settings" />);
  await waitFor(() => expect(root.hasAttribute('data-desktop-toolbar')).toBe(true));
  view.rerender(<Shell surface="onboarding" />);
  await waitFor(() => expect(root.hasAttribute('data-desktop-toolbar')).toBe(false));
  view.rerender(<Shell />);
  await waitFor(() => expect(root.hasAttribute('data-desktop-toolbar')).toBe(true));
  view.unmount();
  expect(root.hasAttribute('data-desktop-toolbar')).toBe(false);
  window.pilotdeckDesktop = { ...window.pilotdeckDesktop, platform: 'win32' } as any;
  render(<Shell />);
  expect(root.hasAttribute('data-desktop-toolbar')).toBe(false);
});
it('updates native Find for actual mounted, visible targets and rechecks on delivery', async () => {
  const setMenuState = vi.fn().mockResolvedValue(undefined);
  let deliver: (command: DesktopCommand) => void = () => {};
  const execute = vi.fn();
  window.pilotdeckDesktop = { platform: 'win32', setMenuState, onCommand: (callback: typeof deliver) => { deliver = callback; return () => {}; } } as any;
  function FileTarget() {
    const containerRef = useRef<HTMLDivElement>(null);
    useRegisterFindShortcutTarget({ scope: 'file', containerRef, onOpen: () => {} });
    return <div ref={containerRef} data-file-search-surface><button>Editor</button></div>;
  }
  function Shell({ open = false, hidden = false }) {
    useDesktopCommands({ canNewConversation: true, hasProject: true, canFind: true, sidebarVisible: true, integrateMacCaption: false, execute });
    return <FindShortcutProvider activeScope="file"><div hidden={hidden}>{open && <FileTarget />}</div></FindShortcutProvider>;
  }
  const view = render(<Shell />);
  expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ canFind: false }));
  act(() => deliver('find'));
  expect(execute).not.toHaveBeenCalled();
  view.rerender(<Shell open />);
  await waitFor(() => expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ canFind: true })));
  act(() => deliver('find'));
  expect(execute).toHaveBeenCalledWith('find');
  view.rerender(<Shell open hidden />);
  execute.mockClear();
  act(() => deliver('find'));
  expect(execute).not.toHaveBeenCalled();
  await waitFor(() => expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ canFind: false })));
  view.rerender(<Shell open />);
  await waitFor(() => expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ canFind: true })));
  view.rerender(<Shell />);
  await waitFor(() => expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ canFind: false })));
});
it('rechecks modal state at delivery, respects context and cleans up the bridge', async () => {
  let deliver: (command: DesktopCommand) => void = () => {};
  const setMenuState = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();
  window.pilotdeckDesktop = { platform: 'darwin', setMenuState, onCommand: (callback: (command: DesktopCommand) => void) => { deliver = callback; return stop; } } as any;
  const execute = vi.fn();
  function Shell({ hasProject = false }) {
    useDesktopCommands({ canNewConversation: true, hasProject, canFind: true, sidebarVisible: true, integrateMacCaption: false, execute });
    return <input aria-label="Editor" />;
  }
  const view = render(<Shell />);
  expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, hasProject: false }));
  act(() => deliver('files'));
  expect(execute).not.toHaveBeenCalled();
  view.rerender(<Shell hasProject />);
  act(() => deliver('files'));
  expect(execute).toHaveBeenLastCalledWith('files');
  const modal = document.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  document.body.append(modal);
  execute.mockClear();
  act(() => deliver('new-project'));
  expect(execute).not.toHaveBeenCalled();
  await waitFor(() => expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ blocked: true })));
  modal.remove();
  act(() => deliver('new-conversation'));
  expect(execute).toHaveBeenLastCalledWith('new-conversation');
  execute.mockClear();
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'b', metaKey: true });
  expect(execute).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'b', metaKey: true, ctrlKey: true });
  expect(execute).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'b', metaKey: true });
  expect(execute).toHaveBeenCalledWith('toggle-sidebar');
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
  expect(setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
});
