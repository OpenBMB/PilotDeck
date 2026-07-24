// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CodeEditorTabBar from './CodeEditorTabBar';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('CodeEditorTabBar', () => {
  const tabs = [{
    id: 'editor-tab-0',
    fileStack: [{
      name: 'index.html',
      path: '/workspace/hundouluo/index.html',
      diffInfo: null,
    }],
    dirty: false,
  }, {
    id: 'editor-tab-1',
    fileStack: [{
      name: 'styles.css',
      path: '/workspace/hundouluo/styles.css',
      diffInfo: null,
    }],
    dirty: false,
  }, {
    id: 'editor-tab-2',
    fileStack: [{
      name: 'README.md',
      path: '/workspace/hundouluo/README.md',
      diffInfo: null,
    }],
    dirty: false,
  }];

  const labels = {
    tabList: 'Open files',
    closeTab: (fileName: string) => `Close ${fileName}`,
    moreActions: 'More tab actions',
    closeCurrent: 'Close',
    closeOthers: 'Close other tabs',
    closeToRight: 'Close tabs to the right',
    closeAll: 'Close all tabs',
    modified: 'Modified',
  };

  it('exposes the full local path and reserves space for workspace actions', () => {
    render(
      <CodeEditorTabBar
        tabs={[tabs[0]]}
        activeTabId="editor-tab-0"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onCloseTabs={vi.fn()}
        reserveToolbarSpace
        labels={labels}
      />,
    );

    const tab = screen.getByRole('tab', {
      name: 'index.html — /workspace/hundouluo/index.html',
    });
    expect(tab.getAttribute('title')).toBe('/workspace/hundouluo/index.html');
    expect(screen.getByRole('tablist', { name: 'Open files' }).className).toContain('pr-32');
    expect(screen.queryByRole('button', { name: 'More tab actions' })).toBeNull();
  });

  it('closes all tabs from the tab context menu', () => {
    const onCloseTabs = vi.fn();
    render(
      <CodeEditorTabBar
        tabs={tabs}
        activeTabId="editor-tab-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onCloseTabs={onCloseTabs}
        labels={labels}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('tab', {
      name: 'styles.css — /workspace/hundouluo/styles.css',
    }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close all tabs' }));

    expect(onCloseTabs).toHaveBeenCalledWith([
      'editor-tab-0',
      'editor-tab-1',
      'editor-tab-2',
    ]);
  });

  it('uses the context-clicked tab for close-to-right', () => {
    const onClose = vi.fn();
    render(
      <CodeEditorTabBar
        tabs={tabs}
        activeTabId="editor-tab-0"
        onSelect={vi.fn()}
        onClose={onClose}
        onCloseTabs={vi.fn()}
        labels={labels}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('tab', {
      name: 'styles.css — /workspace/hundouluo/styles.css',
    }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tabs to the right' }));

    expect(onClose).toHaveBeenCalledWith('editor-tab-2');
  });

  it('focuses and navigates the context menu from the keyboard', async () => {
    render(
      <CodeEditorTabBar
        tabs={tabs}
        activeTabId="editor-tab-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onCloseTabs={vi.fn()}
        labels={labels}
      />,
    );

    const targetTab = screen.getByRole('tab', {
      name: 'styles.css — /workspace/hundouluo/styles.css',
    });
    targetTab.focus();
    fireEvent.keyDown(targetTab, { key: 'F10', shiftKey: true });

    const closeCurrent = screen.getByRole('menuitem', { name: 'Close' });
    await waitFor(() => expect(document.activeElement).toBe(closeCurrent));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Close other tabs' }),
    );

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(targetTab));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
