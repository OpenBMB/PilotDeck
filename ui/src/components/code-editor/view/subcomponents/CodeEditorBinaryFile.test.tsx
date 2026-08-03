// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../../utils/api';
import CodeEditorBinaryFile from './CodeEditorBinaryFile';

const readOfficePreviewStatusMock = vi.hoisted(() => vi.fn(async () => ({
  service: 'builtin',
  libreOffice: {
    available: false,
  },
})));

vi.mock('../../../../utils/officePreviewStatus', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../utils/officePreviewStatus')>();
  return {
    ...original,
    readOfficePreviewStatus: readOfficePreviewStatusMock,
  };
});

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

vi.mock('./SpreadsheetInteractivePreview', () => ({
  default: ({
    activeSheetIndex,
  }: {
    activeSheetIndex: number;
  }) => (
    <div data-testid="spreadsheet-interactive-preview">
      Active worksheet {activeSheetIndex}
    </div>
  ),
}));

vi.mock('./DocxBuiltinPreview', () => ({
  default: () => <div>Built-in DOCX preview</div>,
}));

vi.mock('./PptxBuiltinPreview', () => ({
  default: () => <div>Built-in PPTX preview</div>,
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

  it('loads selectable XLSX data without requiring LibreOffice', async () => {
    vi.spyOn(api, 'spreadsheetInteractivePreview').mockResolvedValue(new Response(
      JSON.stringify({
        version: 1,
        revision: 'test-revision',
        activeSheetIndex: 99,
        sheets: [
          { index: 0, name: '管理摘要' },
          { index: 1, name: '行动项' },
        ],
        warnings: [],
        workbook: {
          id: 'workbook-test',
          name: 'report.xlsx',
          appVersion: '0.25.1',
          locale: 'zhCN',
          styles: {},
          sheetOrder: ['sheet-0', 'sheet-1'],
          sheets: {
            'sheet-0': {
              id: 'sheet-0',
              name: '管理摘要',
            },
            'sheet-1': {
              id: 'sheet-1',
              name: '行动项',
            },
          },
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ));

    render(
      <CodeEditorBinaryFile
        {...baseProps}
        file={{
          name: 'report.xlsx',
          path: '/workspace/hundouluo/report.xlsx',
          diffInfo: null,
        }}
      />,
    );

    expect(await screen.findByText('Active worksheet 0')).not.toBeNull();
    expect(screen.queryByText('spreadsheetPreview.interactiveView')).toBeNull();
    expect(screen.queryByText('spreadsheetPreview.printView')).toBeNull();
    expect(screen.getByTitle('pdfToolbar.zoomOut')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '行动项' }));

    expect(await screen.findByText('Active worksheet 1')).not.toBeNull();
  });

  it('uses only the configured print renderer without showing a per-file view switch', async () => {
    readOfficePreviewStatusMock.mockResolvedValueOnce({
      service: 'libreoffice',
      libreOffice: {
        available: true,
      },
    });
    vi.spyOn(api, 'spreadsheetPreviewManifest').mockResolvedValue(new Response(
      JSON.stringify({
        version: 1,
        revision: 'print-revision',
        activeSheetIndex: 0,
        sheets: [{ index: 0, name: 'Sheet1' }],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    vi.spyOn(api, 'preflightSpreadsheetSheetPreview').mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 206,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );

    render(
      <CodeEditorBinaryFile
        {...baseProps}
        file={{
          name: 'report.xlsx',
          path: '/workspace/hundouluo/report.xlsx',
          diffInfo: null,
        }}
      />,
    );

    expect(await screen.findByRole('button', { name: 'PDF preview' })).not.toBeNull();
    expect(screen.queryByText('spreadsheetPreview.interactiveView')).toBeNull();
    expect(screen.queryByText('spreadsheetPreview.printView')).toBeNull();
    expect(screen.queryByTitle('pdfToolbar.zoomOut')).toBeNull();
  });

  it('uses the bundled DOCX renderer in built-in mode', async () => {
    const readFileBlob = vi.spyOn(api, 'readFileBlob').mockResolvedValue(
      new Response(new Blob(['docx-data']), { status: 200 }),
    );

    render(
      <CodeEditorBinaryFile
        {...baseProps}
        file={{
          name: 'report.docx',
          path: '/workspace/hundouluo/report.docx',
          diffInfo: null,
        }}
      />,
    );

    expect(await screen.findByText('Built-in DOCX preview')).not.toBeNull();
    expect(readFileBlob).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent('pilotdeck:agent-turn-complete', {
      detail: { projectName: 'hundouluo' },
    }));
    window.dispatchEvent(new CustomEvent('pilotdeck:file-updated', {
      detail: {
        projectName: 'hundouluo',
        filePath: 'other.docx',
      },
    }));

    await Promise.resolve();
    expect(readFileBlob).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent('pilotdeck:file-updated', {
      detail: {
        projectName: 'hundouluo',
        filePath: 'report.docx',
      },
    }));

    await waitFor(() => {
      expect(readFileBlob).toHaveBeenCalledTimes(2);
    });
  });

  it('guides legacy Office formats to LibreOffice while built-in preview is selected', async () => {
    render(
      <CodeEditorBinaryFile
        {...baseProps}
        file={{
          name: 'legacy-report.doc',
          path: '/workspace/hundouluo/legacy-report.doc',
          diffInfo: null,
        }}
      />,
    );

    expect(await screen.findByText('officePreview.unsupportedBuiltinTitle')).not.toBeNull();
    expect(screen.getByText('officePreview.configureService')).not.toBeNull();
  });
});
