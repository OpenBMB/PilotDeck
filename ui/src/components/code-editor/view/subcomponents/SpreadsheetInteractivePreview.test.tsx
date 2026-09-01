// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleType, type IWorkbookData } from '@univerjs/core';
import SpreadsheetInteractivePreview from './SpreadsheetInteractivePreview';

const univerState = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
}));
const translate = vi.hoisted(() => (key: string) => key);

vi.mock('@univerjs/core', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  class Univer {
    private container: HTMLElement | null = null;
    private root: ReturnType<typeof createRoot> | null = null;

    constructor() {
      univerState.created += 1;
    }

    registerPlugin(plugin: unknown, options?: { container?: HTMLElement }) {
      if (plugin === 'ui' && options?.container) {
        this.container = options.container;
      }
    }

    mount() {
      if (!this.container) throw new Error('Missing Univer container');
      this.root = createRoot(this.container);
      this.root.render(React.createElement('canvas', { 'data-testid': 'mock-univer-canvas' }));
    }

    dispose() {
      univerState.disposed += 1;
      this.root?.unmount();
      this.root = null;
    }
  }

  return {
    LocaleType: { EN_US: 'enUS', ZH_CN: 'zhCN' },
    LogLevel: { ERROR: 'error' },
    mergeLocales: (...locales: unknown[]) => Object.assign({}, ...locales),
    Univer,
  };
});

vi.mock('@univerjs/core/facade', () => ({
  FUniver: {
    newAPI: (univer: { mount: () => void }) => {
      const cell = {
        getFormula: () => '',
        getDisplayValue: () => 'A1 value',
      };
      const worksheet = {
        getSheetId: () => 'sheet-0',
        getSheetName: () => 'Sheet1',
        getRange: () => cell,
        zoom: vi.fn(),
      };
      const workbook = {
        getActiveSheet: () => worksheet,
        getSheetBySheetId: () => worksheet,
        setActiveSheet: vi.fn(),
        getWorkbookPermission: () => ({ setReadOnly: vi.fn(async () => undefined) }),
      };

      return {
        Event: {
          ActiveSheetChanged: 'ActiveSheetChanged',
          SelectionChanged: 'SelectionChanged',
          SelectionMoveStart: 'SelectionMoveStart',
          SelectionMoveEnd: 'SelectionMoveEnd',
          CellPointerDown: 'CellPointerDown',
          CellPointerUp: 'CellPointerUp',
        },
        createWorkbook: () => univer.mount(),
        getActiveWorkbook: () => workbook,
        addEvent: () => ({ dispose: vi.fn() }),
        registerComponent: () => ({ dispose: vi.fn() }),
      };
    },
  },
}));

vi.mock('@univerjs/design/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/design/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/docs', () => ({ UniverDocsPlugin: 'docs' }));
vi.mock('@univerjs/docs-ui', () => ({ UniverDocsUIPlugin: 'docs-ui' }));
vi.mock('@univerjs/docs-ui/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/docs-ui/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/engine-formula', () => ({ UniverFormulaEnginePlugin: 'formula' }));
vi.mock('@univerjs/engine-render', () => ({ UniverRenderEnginePlugin: 'render' }));
vi.mock('@univerjs/sheets', () => ({ UniverSheetsPlugin: 'sheets' }));
vi.mock('@univerjs/sheets/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/sheets/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/sheets/facade', () => ({}));
vi.mock('@univerjs/sheets-formula', () => ({ UniverSheetsFormulaPlugin: 'sheets-formula' }));
vi.mock('@univerjs/sheets-formula/facade', () => ({}));
vi.mock('@univerjs/sheets-formula-ui', () => ({ UniverSheetsFormulaUIPlugin: 'sheets-formula-ui' }));
vi.mock('@univerjs/sheets-formula-ui/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/sheets-formula-ui/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/sheets-numfmt', () => ({ UniverSheetsNumfmtPlugin: 'sheets-numfmt' }));
vi.mock('@univerjs/sheets-numfmt/facade', () => ({}));
vi.mock('@univerjs/sheets-numfmt-ui', () => ({ UniverSheetsNumfmtUIPlugin: 'sheets-numfmt-ui' }));
vi.mock('@univerjs/sheets-numfmt-ui/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/sheets-numfmt-ui/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/sheets-ui', () => ({ UniverSheetsUIPlugin: 'sheets-ui' }));
vi.mock('@univerjs/sheets-ui/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/sheets-ui/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/sheets-ui/facade', () => ({}));
vi.mock('@univerjs/ui', () => ({ UniverUIPlugin: 'ui' }));
vi.mock('@univerjs/ui/locale/en-US', () => ({ default: {} }));
vi.mock('@univerjs/ui/locale/zh-CN', () => ({ default: {} }));
vi.mock('@univerjs/ui/facade', () => ({}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
vi.mock('lucide-react', () => ({ Search: () => null }));
vi.mock('../../hooks/useFileSearchShortcut', () => ({ useFileSearchShortcut: vi.fn() }));
vi.mock('./ContentReferenceMenu', () => ({ default: () => null }));
vi.mock('./FloatingFileSearchControls', () => ({ default: () => null }));
vi.mock('./RegionSelectionOverlay', () => ({ default: () => null }));
vi.mock('./floatingSelectionAction', () => ({ floatingSelectionSingleActionClassName: '' }));
vi.mock('./spreadsheetContextSelectionIntent', () => ({
  createSpreadsheetContextSelectionIntent: () => ({
    recordPointerDown: vi.fn(),
    recordCellPointerDown: vi.fn(() => false),
    consumeContextAction: vi.fn(() => null),
    reset: vi.fn(),
  }),
  shouldShowSpreadsheetSelectionPopup: () => false,
}));

const workbook = (name: string): IWorkbookData => ({
  id: `workbook-${name}`,
  name,
  appVersion: '0.25.1',
  locale: LocaleType.EN_US,
  styles: {},
  sheetOrder: ['sheet-0'],
  sheets: {
    'sheet-0': {
      id: 'sheet-0',
      name: 'Sheet1',
    },
  },
});

const renderPreview = (data: IWorkbookData) => (
  <StrictMode>
    <SpreadsheetInteractivePreview
      workbook={data}
      fileName="report.xlsx"
      filePath="report.xlsx"
      activeSheetIndex={0}
      zoom={1}
      onActiveSheetChange={vi.fn()}
      onError={vi.fn()}
    />
  </StrictMode>
);

const flushLifecycleTimers = async () => {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(vi.getTimerCount()).toBe(0);
};

describe('SpreadsheetInteractivePreview lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    univerState.created = 0;
    univerState.disposed = 0;
  });

  afterEach(() => {
    cleanup();
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('serializes nested React root replacement under StrictMode', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(renderPreview(workbook('first')));

    await flushLifecycleTimers();

    expect(screen.getByTestId('mock-univer-canvas')).not.toBeNull();
    expect(univerState.created).toBe(1);
    expect(univerState.disposed).toBe(0);

    view.rerender(renderPreview(workbook('second')));
    await flushLifecycleTimers();

    expect(screen.getByTestId('mock-univer-canvas')).not.toBeNull();
    expect(univerState.created).toBe(2);
    expect(univerState.disposed).toBe(1);
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain(
      'Attempted to synchronously unmount a root',
    );

    view.unmount();
    await flushLifecycleTimers();
    expect(univerState.disposed).toBe(2);
    consoleError.mockRestore();
  });
});
