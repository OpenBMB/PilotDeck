// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfDocumentPreview from './PdfDocumentPreview';

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument: pdfMocks.getDocument,
}));

vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({
  default: 'pdf-worker.js',
}));

class ResizeObserverMock {
  observe() {}

  disconnect() {}
}

class IntersectionObserverMock {
  observe() {}

  disconnect() {}
}

beforeEach(() => {
  pdfMocks.getDocument.mockReset();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PdfDocumentPreview search', () => {
  it('does not restore stale results after the query changes during a search', async () => {
    let resolveTextContent!: (value: { items: Array<{ str: string }> }) => void;
    const pendingTextContent = new Promise<{ items: Array<{ str: string }> }>((resolve) => {
      resolveTextContent = resolve;
    });
    const firstPage = {
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
    };
    const searchPage = {
      getTextContent: vi.fn(() => pendingTextContent),
    };
    const pdfDocument = {
      numPages: 1,
      getPage: vi.fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(searchPage),
      destroy: vi.fn(),
    };
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve(pdfDocument),
      destroy: vi.fn(),
    });

    render(
      <PdfDocumentPreview
        url="/report.pdf"
        projectName="demo"
        fileName="report.pdf"
        filePath="report.pdf"
        source="pdf"
      />,
    );

    const openSearchButton = await screen.findByRole('button', { name: 'pdfToolbar.search' });
    await waitFor(() => expect((openSearchButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(openSearchButton);

    const input = screen.getByPlaceholderText('pdfToolbar.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'old query' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('pdfToolbar.searching')).not.toBeNull());

    fireEvent.change(input, { target: { value: 'new query' } });
    resolveTextContent({ items: [{ str: 'old query' }] });

    await waitFor(() => {
      expect(screen.queryByText('pdfToolbar.resultOf')).toBeNull();
      expect(screen.queryByText('pdfToolbar.searching')).toBeNull();
    });
    expect((screen.getByRole('button', { name: 'pdfToolbar.nextResult' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('clamps the restored page when a refreshed document has fewer pages', async () => {
    const createDocument = (numPages: number) => ({
      numPages,
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
      })),
      destroy: vi.fn(),
    });
    const firstDocument = createDocument(3);
    const refreshedDocument = createDocument(1);
    const destroyFirstLoadingTask = vi.fn();
    pdfMocks.getDocument
      .mockReturnValueOnce({
        promise: Promise.resolve(firstDocument),
        destroy: destroyFirstLoadingTask,
      })
      .mockReturnValueOnce({
        promise: Promise.resolve(refreshedDocument),
        destroy: vi.fn(),
      });

    const { rerender } = render(
      <PdfDocumentPreview
        url="/report.pdf?revision=1"
        projectName="demo"
        fileName="report.pdf"
        filePath="report.pdf"
        source="pdf"
      />,
    );

    const pageInput = await screen.findByRole('textbox', { name: 'pdfToolbar.goToPage' });
    await waitFor(() => expect((pageInput as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(pageInput, { target: { value: '3' } });
    fireEvent.blur(pageInput);
    expect((pageInput as HTMLInputElement).value).toBe('3');

    rerender(
      <PdfDocumentPreview
        url="/report.pdf?revision=2"
        projectName="demo"
        fileName="report.pdf"
        filePath="report.pdf"
        source="pdf"
      />,
    );

    await waitFor(() => {
      expect(destroyFirstLoadingTask).toHaveBeenCalledOnce();
      expect((screen.getByRole('textbox', {
        name: 'pdfToolbar.goToPage',
      }) as HTMLInputElement).value).toBe('1');
    });
  });
});
