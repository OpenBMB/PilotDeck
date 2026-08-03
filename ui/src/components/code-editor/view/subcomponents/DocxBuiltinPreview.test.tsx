// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocxBuiltinPreview from './DocxBuiltinPreview';

const renderAsyncMock = vi.hoisted(() => vi.fn(async (
  _blob: Blob,
  bodyContainer: HTMLElement,
) => {
  const wrapper = document.createElement('div');
  wrapper.className = 'pilotdeck-docx-wrapper';
  const page = document.createElement('section');
  page.className = 'pilotdeck-docx';
  page.textContent = 'Document body';
  wrapper.append(page);
  bodyContainer.append(wrapper);
}));

vi.mock('docx-preview', () => ({
  renderAsync: renderAsyncMock,
}));

afterEach(() => {
  cleanup();
  renderAsyncMock.mockClear();
});

describe('DocxBuiltinPreview', () => {
  it('does not rebuild the document when callback props change', async () => {
    const blob = new Blob(['docx-data']);
    const props = {
      blob,
      fileName: 'report.docx',
      filePath: 'report.docx',
      onError: vi.fn(),
    };
    const { rerender } = render(<DocxBuiltinPreview {...props} />);

    await waitFor(() => {
      expect(renderAsyncMock).toHaveBeenCalledTimes(1);
    });

    rerender(<DocxBuiltinPreview {...props} onError={vi.fn()} />);

    await Promise.resolve();
    expect(renderAsyncMock).toHaveBeenCalledTimes(1);
  });
});
