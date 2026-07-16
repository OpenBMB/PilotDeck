// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CodeEditorTabBar from './CodeEditorTabBar';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('CodeEditorTabBar', () => {
  it('exposes the full local path and reserves space for workspace actions', () => {
    render(
      <CodeEditorTabBar
        tabs={[{
          id: 'editor-tab-0',
          fileStack: [{
            name: 'index.html',
            path: '/workspace/hundouluo/index.html',
            diffInfo: null,
          }],
          dirty: false,
        }]}
        activeTabId="editor-tab-0"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        reserveToolbarSpace
        labels={{
          tabList: 'Open files',
          closeTab: (fileName) => `Close ${fileName}`,
          modified: 'Modified',
        }}
      />,
    );

    const tab = screen.getByRole('tab', {
      name: 'index.html — /workspace/hundouluo/index.html',
    });
    expect(tab.getAttribute('title')).toBe('/workspace/hundouluo/index.html');
    expect(screen.getByRole('tablist', { name: 'Open files' }).className).toContain('pr-32');
  });
});
