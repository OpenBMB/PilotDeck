// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createEditorToolbarPanelExtension } from './editorToolbarPanel';

const file = {
  name: 'ultrarag_deck.mjs',
  path: '/workspace/ultrarag_deck.mjs',
  diffInfo: null,
};

const labels = {
  changes: 'changes',
  previousChange: 'previous',
  nextChange: 'next',
  hideDiff: 'hide diff',
  showDiff: 'show diff',
  collapse: 'collapse',
  expand: 'expand',
};

describe('createEditorToolbarPanelExtension', () => {
  it('does not create an empty toolbar when workspace-only actions are removed', () => {
    const extension = createEditorToolbarPanelExtension({
      file,
      showDiff: false,
      isSidebar: true,
      isExpanded: false,
      onToggleDiff: vi.fn(),
      onPopOut: null,
      onToggleExpand: null,
      labels,
    });

    expect(extension).toEqual([]);
  });

  it('retains the toolbar for file diffs', () => {
    const extension = createEditorToolbarPanelExtension({
      file: {
        ...file,
        diffInfo: {
          old_string: 'before',
          new_string: 'after',
        },
      },
      showDiff: true,
      isSidebar: true,
      isExpanded: false,
      onToggleDiff: vi.fn(),
      onPopOut: null,
      onToggleExpand: null,
      labels,
    });

    expect(extension).toHaveLength(1);
  });
});
