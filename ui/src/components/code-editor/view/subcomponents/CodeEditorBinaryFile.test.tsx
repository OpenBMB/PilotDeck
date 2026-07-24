// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditorBinaryFile from './CodeEditorBinaryFile';

vi.mock('./PdfDocumentPreview', () => ({
  default: ({
    navigationMode,
    showPageControls,
    onToggleFullscreen,
  }: {
    navigationMode?: string;
    showPageControls?: boolean;
    onToggleFullscreen?: (() => void) | null;
  }) => (
    <button
      type="button"
      data-navigation-mode={navigationMode}
      data-page-controls={String(showPageControls !== false)}
      onClick={() => onToggleFullscreen?.()}
    >
      PDF preview
    </button>
  ),
}));

const baseProps = {
  file: {
    name: 'archive.bin',
    path: '/workspace/hundouluo/archive.bin',
    diffInfo: null,
  },
  projectName: 'hundouluo',
  isSidebar: true,
  isFullscreen: false,
  onClose: vi.fn(),
  onToggleFullscreen: vi.fn(),
  title: 'Binary file',
  message: 'Preview unavailable',
  headerPrefix: <div>File tabs</div>,
};

afterEach(cleanup);

describe('CodeEditorBinaryFile', () => {
  it('keeps file identity in the full preview header', () => {
    render(<CodeEditorBinaryFile {...baseProps} />);

    expect(screen.getByText('archive.bin')).not.toBeNull();
  });

  it('does not add an empty overlay above the workspace file tabs', () => {
    const { container } = render(<CodeEditorBinaryFile {...baseProps} compactHeader />);

    expect(screen.queryByText('archive.bin')).toBeNull();
    expect(container.querySelector('.absolute.right-2.top-1')).toBeNull();
  });

  it('enables page navigation and workspace expansion for PDF files', () => {
    const onToggleExpand = vi.fn();
    render(
      <CodeEditorBinaryFile
        {...baseProps}
        file={{
          name: 'report.pdf',
          path: '/workspace/hundouluo/report.pdf',
          diffInfo: null,
        }}
        onToggleExpand={onToggleExpand}
      />,
    );

    const preview = screen.getByRole('button', { name: 'PDF preview' });
    expect(preview.getAttribute('data-navigation-mode')).toBe('pages');
    expect(preview.getAttribute('data-page-controls')).toBe('true');
    preview.click();
    expect(onToggleExpand).toHaveBeenCalledOnce();
  });

  it('keeps the fullscreen action available for image previews outside the sidebar', () => {
    const onToggleFullscreen = vi.fn();
    render(
      <CodeEditorBinaryFile
        {...baseProps}
        file={{
          name: 'screenshot.png',
          path: '/workspace/hundouluo/screenshot.png',
          diffInfo: null,
        }}
        projectName={undefined}
        isSidebar={false}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );

    fireEvent.click(screen.getByTitle('actions.fullscreen'));
    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });
});
