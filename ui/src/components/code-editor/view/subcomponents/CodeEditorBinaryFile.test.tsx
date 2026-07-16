// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditorBinaryFile from './CodeEditorBinaryFile';

vi.mock('./PdfDocumentPreview', () => ({
  default: () => <div>PDF preview</div>,
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

  it('uses a toolbar-only overlay in workspace mode', () => {
    const { container } = render(<CodeEditorBinaryFile {...baseProps} compactHeader />);

    expect(screen.queryByText('archive.bin')).toBeNull();
    expect(container.querySelector('.absolute.right-2.top-1')).not.toBeNull();
  });
});
