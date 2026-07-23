// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditorHeader from './CodeEditorHeader';

const labels = {
  showingChanges: 'Showing changes',
  editMarkdown: 'Edit Markdown',
  previewMarkdown: 'Preview Markdown',
  editHtml: 'View HTML source',
  previewHtml: 'Preview HTML',
  download: 'Download',
  save: 'Save',
  saving: 'Saving',
  saved: 'Saved',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  expand: 'Expand',
  collapse: 'Collapse',
  close: 'Close',
  goBack: 'Go back',
};

const baseProps = {
  file: {
    name: 'index.html',
    path: '/workspace/hundouluo/index.html',
    diffInfo: null,
  },
  isSidebar: true,
  isFullscreen: false,
  isMarkdownFile: false,
  markdownPreview: false,
  saving: false,
  saveSuccess: false,
  isExpanded: false,
  onToggleExpand: vi.fn(),
  onToggleMarkdownPreview: vi.fn(),
  onDownload: vi.fn(),
  onSave: vi.fn(),
  onToggleFullscreen: vi.fn(),
  onClose: vi.fn(),
  labels,
};

afterEach(cleanup);

describe('CodeEditorHeader', () => {
  it('keeps file identity in the full header', () => {
    render(<CodeEditorHeader {...baseProps} />);

    expect(screen.getByText('index.html')).not.toBeNull();
    expect(screen.getByText('/workspace/hundouluo/index.html')).not.toBeNull();
  });

  it('uses a toolbar-only overlay in workspace mode', () => {
    const { container } = render(<CodeEditorHeader {...baseProps} compact />);

    expect(screen.queryByText('index.html')).toBeNull();
    expect(screen.queryByText('/workspace/hundouluo/index.html')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Expand' })).not.toBeNull();
    expect(container.firstElementChild?.className).toContain('absolute');
  });

  it('offers a source toggle for HTML previews', () => {
    render(<CodeEditorHeader {...baseProps} isHtmlFile htmlPreview />);

    expect(screen.getByRole('button', { name: 'View HTML source' })).not.toBeNull();
  });
});
