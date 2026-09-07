import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LocaleType,
  LogLevel,
  mergeLocales,
  Univer,
  type IWorkbookData,
} from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import DesignEnUS from '@univerjs/design/locale/en-US';
import DesignZhCN from '@univerjs/design/locale/zh-CN';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import DocsUIEnUS from '@univerjs/docs-ui/locale/en-US';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import '@univerjs/sheets/facade';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import '@univerjs/sheets-formula/facade';
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui';
import SheetsFormulaUIEnUS from '@univerjs/sheets-formula-ui/locale/en-US';
import SheetsFormulaUIZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import '@univerjs/sheets-numfmt/facade';
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui';
import SheetsNumfmtUIEnUS from '@univerjs/sheets-numfmt-ui/locale/en-US';
import SheetsNumfmtUIZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';
import '@univerjs/sheets-ui/facade';
import SheetsUIEnUS from '@univerjs/sheets-ui/locale/en-US';
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN';
import SheetsEnUS from '@univerjs/sheets/locale/en-US';
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN';
import { UniverUIPlugin } from '@univerjs/ui';
import '@univerjs/ui/facade';
import UIEnUS from '@univerjs/ui/locale/en-US';
import UIZhCN from '@univerjs/ui/locale/zh-CN';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  createCellRangeContentReference,
  createImageRegionContentReference,
  type CellRangeSnapshot,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from '../../../../types/contentReference';
import { useFileSearchShortcut } from '../../hooks/useFileSearchShortcut';
import ContentReferenceMenu from './ContentReferenceMenu';
import FloatingFileSearchControls from './FloatingFileSearchControls';
import RegionSelectionOverlay, { type CapturedRegion } from './RegionSelectionOverlay';
import {
  floatingSelectionSingleActionClassName,
} from './floatingSelectionAction';
import {
  createSpreadsheetContextSelectionIntent,
  shouldShowSpreadsheetSelectionPopup,
  type SpreadsheetSelectionOrigin,
} from './spreadsheetContextSelectionIntent';
import {
  SPREADSHEET_UNIVER_SHEETS_UI_CONFIG,
  SPREADSHEET_UNIVER_UI_CONFIG,
} from './spreadsheetUniverConfig';

import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';
import '@univerjs/sheets-formula-ui/lib/index.css';
import '@univerjs/sheets-numfmt-ui/lib/index.css';

type SpreadsheetInteractivePreviewProps = {
  workbook: IWorkbookData;
  projectName?: string;
  fileName: string;
  filePath: string;
  revision?: string;
  activeSheetIndex: number;
  zoom: number;
  onActiveSheetChange: (sheetIndex: number) => void;
  onError: (error: Error) => void;
};

type UniverRuntime = {
  univer: Univer;
  api: ReturnType<typeof FUniver.newAPI>;
  disposeActiveSheetListener?: () => void;
  disposeSelectionListener?: () => void;
  disposeSelectionMoveStartListener?: () => void;
  disposeSelectionMoveEndListener?: () => void;
  disposeCellPointerDownListener?: () => void;
  disposeCellPointerUpListener?: () => void;
  disposeContextSelectionIntent?: () => void;
  disposePopupComponent?: () => void;
  disposeSelectionPopup?: () => void;
};

type SelectedCell = {
  address: string;
  value: string;
};

type SpreadsheetSelectionDraft = {
  sheetId: string;
  sheetName: string;
  ranges: string[];
  activeRange: string;
  cells: CellRangeSnapshot[];
  headers?: string[][];
  surroundingValues?: string[][];
};

type SpreadsheetSearchMatch = {
  sheetId: string;
  sheetIndex: number;
  row: number;
  column: number;
};

const MAX_REFERENCE_SNAPSHOT_ROWS = 100;
const MAX_REFERENCE_SNAPSHOT_COLUMNS = 50;
const MAX_REFERENCE_CONTEXT_ROWS = 20;
const MAX_REFERENCE_CONTEXT_COLUMNS = 30;

const UNIVER_LOCALES = {
  [LocaleType.EN_US]: mergeLocales(
    DesignEnUS,
    UIEnUS,
    DocsUIEnUS,
    SheetsEnUS,
    SheetsUIEnUS,
    SheetsFormulaUIEnUS,
    SheetsNumfmtUIEnUS,
  ),
  [LocaleType.ZH_CN]: mergeLocales(
    DesignZhCN,
    UIZhCN,
    DocsUIZhCN,
    SheetsZhCN,
    SheetsUIZhCN,
    SheetsFormulaUIZhCN,
    SheetsNumfmtUIZhCN,
  ),
};

function getSheetIndex(sheetId: string) {
  const match = /^sheet-(\d+)$/.exec(sheetId);
  return match ? Number(match[1]) : null;
}

function getColumnName(column: number) {
  let value = column + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

export default function SpreadsheetInteractivePreview({
  workbook,
  projectName,
  fileName,
  filePath,
  revision,
  activeSheetIndex,
  zoom,
  onActiveSheetChange,
  onError,
}: SpreadsheetInteractivePreviewProps) {
  const { t, i18n } = useTranslation('codeEditor');
  const univerLocale = i18n.resolvedLanguage?.toLowerCase().startsWith('zh')
    ? LocaleType.ZH_CN
    : LocaleType.EN_US;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<UniverRuntime | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedCell>({
    address: 'A1',
    value: '',
  });
  const [selectionDraft, setSelectionDraft] = useState<SpreadsheetSelectionDraft | null>(null);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SpreadsheetSearchMatch[]>([]);
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const selectionDraftRef = useRef<SpreadsheetSelectionDraft | null>(null);
  const addCellReferenceRef = useRef<() => void>(() => undefined);
  const referenceModeRef = useRef<ContentReferenceSelectionMode | null>(referenceMode);
  const onActiveSheetChangeRef = useRef(onActiveSheetChange);
  const onErrorRef = useRef(onError);
  const activeSheetIndexRef = useRef(activeSheetIndex);
  const zoomRef = useRef(zoom);
  onActiveSheetChangeRef.current = onActiveSheetChange;
  onErrorRef.current = onError;
  activeSheetIndexRef.current = activeSheetIndex;
  zoomRef.current = zoom;
  referenceModeRef.current = referenceMode;
  const openSearch = useCallback(() => {
    runtimeRef.current?.disposeSelectionPopup?.();
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setSearchMatchIndex(0);
  }, []);
  useFileSearchShortcut({
    containerRef: surfaceRef,
    enabled: runtimeReady,
    onOpen: openSearch,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let disposed = false;
    let runtime: UniverRuntime | null = null;
    setRuntimeReady(false);

    // Univer mounts its own React root into `container`. React StrictMode replays
    // effects during development (setup -> cleanup -> setup), and disposing that
    // nested root synchronously from the replay cleanup races with the next mount.
    // Deferring initialization lets the synthetic cleanup cancel the first setup
    // before Univer creates a root at all.
    const initializeTimer = window.setTimeout(() => {
      if (disposed) return;

      try {
        const univer = new Univer({
          locale: univerLocale,
          locales: {
            [univerLocale]: UNIVER_LOCALES[univerLocale],
          },
          logLevel: LogLevel.ERROR,
        });

        univer.registerPlugin(UniverRenderEnginePlugin);
        univer.registerPlugin(UniverFormulaEnginePlugin);
        univer.registerPlugin(UniverUIPlugin, {
          container,
          ...SPREADSHEET_UNIVER_UI_CONFIG,
        });
        univer.registerPlugin(UniverDocsPlugin);
        univer.registerPlugin(UniverDocsUIPlugin);
        univer.registerPlugin(UniverSheetsPlugin);
        univer.registerPlugin(
          UniverSheetsUIPlugin,
          SPREADSHEET_UNIVER_SHEETS_UI_CONFIG,
        );
        univer.registerPlugin(UniverSheetsFormulaPlugin);
        univer.registerPlugin(UniverSheetsFormulaUIPlugin);
        univer.registerPlugin(UniverSheetsNumfmtPlugin);
        univer.registerPlugin(UniverSheetsNumfmtUIPlugin);

        const api = FUniver.newAPI(univer);
        api.createWorkbook({ ...workbook, locale: univerLocale });
        const fWorkbook = api.getActiveWorkbook();
        const contextSelectionIntent = createSpreadsheetContextSelectionIntent<
          ReturnType<NonNullable<typeof fWorkbook>['getActiveSheet']>
        >();
        let selectionPopup: { dispose: () => void } | null = null;
        const disposeSelectionPopup = () => {
          selectionPopup?.dispose();
          selectionPopup = null;
        };
        const popupComponentKey = `pilotdeck-cell-reference-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const popupComponent = api.registerComponent(
          popupComponentKey,
          () => (
            <button
              type="button"
              className={floatingSelectionSingleActionClassName}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={() => addCellReferenceRef.current()}
            >
              {t('selection.chatInPilotDeck')}
            </button>
          ),
        );
        const updateSelectedCell = (
          worksheet: ReturnType<NonNullable<typeof fWorkbook>['getActiveSheet']>,
          row = 0,
          column = 0,
        ) => {
          const cell = worksheet.getRange(row, column);
          const formula = cell.getFormula();
          setSelectedCell({
            address: `${getColumnName(column)}${row + 1}`,
            value: formula || cell.getDisplayValue(),
          });
        };
        const syncSelection = (
          worksheet: ReturnType<NonNullable<typeof fWorkbook>['getActiveSheet']>,
          selections: Array<{
            startRow: number;
            endRow: number;
            startColumn: number;
            endColumn: number;
          }>,
          origin: SpreadsheetSelectionOrigin,
        ) => {
          const selection = selections[0];
          if (!selection) {
            selectionDraftRef.current = null;
            setSelectionDraft(null);
            disposeSelectionPopup();
            return;
          }
          updateSelectedCell(
            worksheet,
            selection.startRow,
            selection.startColumn,
          );
          const cells = selections.map((selectedRange) => {
            const range = worksheet.getRange(selectedRange);
            const rowCount = selectedRange.endRow - selectedRange.startRow + 1;
            const columnCount = selectedRange.endColumn - selectedRange.startColumn + 1;
            const snapshotRowCount = Math.min(rowCount, MAX_REFERENCE_SNAPSHOT_ROWS);
            const snapshotColumnCount = Math.min(columnCount, MAX_REFERENCE_SNAPSHOT_COLUMNS);
            const snapshotRange = worksheet.getRange(
              selectedRange.startRow,
              selectedRange.startColumn,
              snapshotRowCount,
              snapshotColumnCount,
            );
            return {
              range: range.getA1Notation(),
              displayValues: snapshotRange.getDisplayValues(),
              rawValues: snapshotRange.getValues(),
              formulas: snapshotRange.getFormulas(),
              rowCount,
              columnCount,
              truncated: rowCount > snapshotRowCount || columnCount > snapshotColumnCount,
            };
          });
          const headerRowCount = Math.min(2, selection.startRow);
          const headerColumnCount = Math.min(
            selection.endColumn - selection.startColumn + 1,
            MAX_REFERENCE_CONTEXT_COLUMNS,
          );
          const headers = headerRowCount > 0
            ? worksheet.getRange(
              selection.startRow - headerRowCount,
              selection.startColumn,
              headerRowCount,
              headerColumnCount,
            ).getDisplayValues()
            : undefined;
          const contextStartRow = Math.max(0, selection.startRow - 1);
          const contextStartColumn = Math.max(0, selection.startColumn - 1);
          const surroundingValues = worksheet.getRange(
            contextStartRow,
            contextStartColumn,
            Math.min(
              selection.endRow - contextStartRow + 2,
              MAX_REFERENCE_CONTEXT_ROWS,
            ),
            Math.min(
              selection.endColumn - contextStartColumn + 2,
              MAX_REFERENCE_CONTEXT_COLUMNS,
            ),
          ).getDisplayValues();
          const nextDraft = {
            sheetId: worksheet.getSheetId(),
            sheetName: worksheet.getSheetName(),
            ranges: cells.map((cell) => cell.range),
            activeRange: cells[0]?.range || `${getColumnName(selection.startColumn)}${selection.startRow + 1}`,
            cells,
            headers,
            surroundingValues,
          };
          selectionDraftRef.current = nextDraft;
          setSelectionDraft(nextDraft);

          if (!shouldShowSpreadsheetSelectionPopup(
            origin,
            referenceModeRef.current === 'region',
          )) return;
          disposeSelectionPopup();
          selectionPopup = worksheet.getRange(selection).attachRangePopup({
            componentKey: popupComponentKey,
            direction: 'top-center',
            offset: [0, -8],
          }) || null;
        };
        const syncCurrentSelection = (
          worksheet: ReturnType<NonNullable<typeof fWorkbook>['getActiveSheet']>,
          origin: SpreadsheetSelectionOrigin,
        ) => {
          const selections = worksheet
            .getSelection()
            ?.getActiveRangeList()
            .map((range) => range.getRange()) || [];
          syncSelection(worksheet, selections, origin);
        };
        const handleSheetPointerDown = (event: PointerEvent) => {
          contextSelectionIntent.recordPointerDown(event.button, event.ctrlKey);
        };
        const handleSheetContextMenu = (event: MouseEvent) => {
          event.preventDefault();
        };
        container.addEventListener('pointerdown', handleSheetPointerDown, true);
        container.addEventListener('contextmenu', handleSheetContextMenu);
        if (fWorkbook) {
          fWorkbook.setActiveSheet(`sheet-${activeSheetIndexRef.current}`);
          fWorkbook.getActiveSheet().zoom(zoomRef.current);
          void fWorkbook.getWorkbookPermission().setReadOnly();
          updateSelectedCell(fWorkbook.getActiveSheet());
        }
        const activeSheetListener = api.addEvent(
          api.Event.ActiveSheetChanged,
          ({ activeSheet }) => {
            const nextIndex = getSheetIndex(activeSheet.getSheetId());
            if (nextIndex !== null) onActiveSheetChangeRef.current(nextIndex);
            updateSelectedCell(activeSheet);
            selectionDraftRef.current = null;
            setSelectionDraft(null);
            disposeSelectionPopup();
          },
        );
        const selectionListener = api.addEvent(
          api.Event.SelectionChanged,
          ({ worksheet, selections }) => {
            disposeSelectionPopup();
            syncSelection(worksheet, selections, 'passive');
          },
        );
        const selectionMoveStartListener = api.addEvent(
          api.Event.SelectionMoveStart,
          () => {
            disposeSelectionPopup();
          },
        );
        const selectionMoveEndListener = api.addEvent(
          api.Event.SelectionMoveEnd,
          ({ worksheet, selections }) => {
            disposeSelectionPopup();
            syncSelection(worksheet, selections, 'passive');
          },
        );
        const cellPointerDownListener = api.addEvent(
          api.Event.CellPointerDown,
          ({ worksheet }) => {
            if (contextSelectionIntent.recordCellPointerDown(worksheet)) {
              disposeSelectionPopup();
            }
          },
        );
        const cellPointerUpListener = api.addEvent(
          api.Event.CellPointerUp,
          () => {
            const worksheet = contextSelectionIntent.consumeContextAction();
            if (!worksheet) return;
            window.requestAnimationFrame(() => {
              if (disposed) return;
              syncCurrentSelection(worksheet, 'context-action');
            });
          },
        );
        runtime = {
          univer,
          api,
          disposeActiveSheetListener: () => activeSheetListener.dispose(),
          disposeSelectionListener: () => selectionListener.dispose(),
          disposeSelectionMoveStartListener: () => selectionMoveStartListener.dispose(),
          disposeSelectionMoveEndListener: () => selectionMoveEndListener.dispose(),
          disposeCellPointerDownListener: () => cellPointerDownListener.dispose(),
          disposeCellPointerUpListener: () => cellPointerUpListener.dispose(),
          disposeContextSelectionIntent: () => {
            container.removeEventListener('pointerdown', handleSheetPointerDown, true);
            container.removeEventListener('contextmenu', handleSheetContextMenu);
            contextSelectionIntent.reset();
          },
          disposePopupComponent: () => popupComponent.dispose(),
          disposeSelectionPopup,
        };
        runtimeRef.current = runtime;
        setRuntimeReady(true);
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(initializeTimer);
      const runtimeToDispose = runtime;
      if (runtimeRef.current === runtimeToDispose) {
        runtimeRef.current = null;
      }
      if (!runtimeToDispose) return;

      // Univer's dispose path synchronously unmounts its nested React root. Run it
      // after the outer React commit so it cannot delete nodes from a replacement
      // root that is being mounted during the same commit.
      window.setTimeout(() => {
        runtimeToDispose.disposeSelectionPopup?.();
        runtimeToDispose.disposeActiveSheetListener?.();
        runtimeToDispose.disposeSelectionListener?.();
        runtimeToDispose.disposeSelectionMoveStartListener?.();
        runtimeToDispose.disposeSelectionMoveEndListener?.();
        runtimeToDispose.disposeCellPointerDownListener?.();
        runtimeToDispose.disposeCellPointerUpListener?.();
        runtimeToDispose.disposeContextSelectionIntent?.();
        runtimeToDispose.disposePopupComponent?.();
        runtimeToDispose.univer.dispose();
      }, 0);
    };
  }, [t, univerLocale, workbook]);

  useEffect(() => {
    const fWorkbook = runtimeRef.current?.api.getActiveWorkbook();
    if (!fWorkbook) return;
    const targetSheetId = `sheet-${activeSheetIndex}`;
    if (fWorkbook.getActiveSheet().getSheetId() !== targetSheetId) {
      fWorkbook.setActiveSheet(targetSheetId);
    }
    fWorkbook.getActiveSheet().zoom(zoom);
  }, [activeSheetIndex, zoom]);

  useEffect(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const fWorkbook = runtimeRef.current?.api.getActiveWorkbook();
    if (!runtimeReady || !normalizedQuery || !fWorkbook) {
      setSearchMatches([]);
      setSearchMatchIndex(0);
      return;
    }

    const nextMatches: SpreadsheetSearchMatch[] = [];
    workbook.sheetOrder.forEach((sheetId, sheetIndex) => {
      const worksheet = fWorkbook.getSheetBySheetId(sheetId);
      const sheetData = workbook.sheets[sheetId];
      if (!worksheet || !sheetData?.cellData) return;

      Object.entries(sheetData.cellData).forEach(([rowKey, rowData]) => {
        const row = Number(rowKey);
        if (!Number.isInteger(row) || !rowData) return;
        Object.keys(rowData).forEach((columnKey) => {
          const column = Number(columnKey);
          if (!Number.isInteger(column)) return;
          const displayValue = worksheet.getRange(row, column).getDisplayValue();
          if (displayValue.toLocaleLowerCase().includes(normalizedQuery)) {
            nextMatches.push({ sheetId, sheetIndex, row, column });
          }
        });
      });
    });

    setSearchMatches(nextMatches);
    setSearchMatchIndex(0);
  }, [runtimeReady, searchQuery, workbook]);

  useEffect(() => {
    if (searchMatches.length === 0) return;
    const match = searchMatches[Math.min(searchMatchIndex, searchMatches.length - 1)];
    const fWorkbook = runtimeRef.current?.api.getActiveWorkbook();
    const worksheet = fWorkbook?.getSheetBySheetId(match.sheetId);
    if (!fWorkbook || !worksheet) return;
    runtimeRef.current?.disposeSelectionPopup?.();
    fWorkbook.setActiveSheet(worksheet);
    worksheet.getRange(match.row, match.column).activate();
    onActiveSheetChangeRef.current(match.sheetIndex);
  }, [searchMatchIndex, searchMatches]);

  const moveSearch = useCallback((direction: -1 | 1) => {
    if (searchMatches.length === 0) return;
    setSearchMatchIndex((current) => (
      (current + direction + searchMatches.length) % searchMatches.length
    ));
  }, [searchMatches.length]);

  const capabilities: ReferenceCapabilities = {
    text: { state: 'unavailable', reason: 'NO_TEXT_LAYER' },
    cells: runtimeRef.current
      ? { state: 'available' }
      : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    region: runtimeRef.current
      ? { state: 'available' }
      : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    recommendedMode: 'cells',
  };

  const addCellReference = () => {
    const draft = selectionDraftRef.current;
    if (!draft) return;
    const reference = createCellRangeContentReference({
      selectionMode: 'cells',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        ...(revision ? { revision: { id: revision } } : {}),
      },
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'semantic' },
      locator: {
        surface: 'sheet',
        sheetId: draft.sheetId,
        sheetName: draft.sheetName,
        ranges: draft.ranges,
        activeRange: draft.activeRange,
      },
      cells: draft.cells,
      headers: draft.headers,
      surroundingValues: draft.surroundingValues,
    });
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', { detail: reference }));
    selectionDraftRef.current = null;
    setSelectionDraft(null);
    runtimeRef.current?.disposeSelectionPopup?.();
  };
  addCellReferenceRef.current = addCellReference;

  useEffect(() => {
    if (referenceMode === 'region') {
      runtimeRef.current?.disposeSelectionPopup?.();
    }
  }, [referenceMode]);

  const handleRegionCommit = (capture: CapturedRegion) => {
    const activeSheet = runtimeRef.current?.api.getActiveWorkbook()?.getActiveSheet();
    const sheetId = activeSheet?.getSheetId() || `sheet-${activeSheetIndex}`;
    const sheetName = activeSheet?.getSheetName() || sheetId;
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        ...(revision ? { revision: { id: revision } } : {}),
      },
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'visual' },
      locator: {
        surface: 'sheet',
        sheetId,
        sheetName,
        rect: capture.rect,
        ...(selectionDraft?.activeRange ? { anchorRange: selectionDraft.activeRange } : {}),
      },
      image: {
        name: `reference-${fileName}-${sheetName}-${Date.now()}.png`,
        mimeType: 'image/png',
        width: capture.width,
        height: capture.height,
        dataUrl: capture.dataUrl,
      },
    });
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', { detail: reference }));
    setReferenceMode(null);
  };

  return (
    <div
      ref={surfaceRef}
      data-file-search-surface
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white"
    >
      <div className="relative z-20 flex h-9 shrink-0 items-center border-b border-border bg-background text-sm">
        <div
          aria-label={t('contentReference.spreadsheet.currentCell')}
          className="w-20 shrink-0 border-r border-border px-3 font-medium text-foreground"
        >
          {selectedCell.address}
        </div>
        <div
          aria-hidden="true"
          className="shrink-0 border-r border-border px-3 font-serif italic text-muted-foreground"
        >
          fx
        </div>
        <input
          aria-label={t('contentReference.spreadsheet.cellValue')}
          className="min-w-0 flex-1 bg-transparent px-3 text-foreground outline-none"
          readOnly
          value={selectedCell.value}
        />
        <button
          type="button"
          onClick={() => {
            if (searchOpen) closeSearch();
            else openSearch();
          }}
          title={t('builtinOfficePreview.search')}
          aria-label={t('builtinOfficePreview.search')}
          className={[
            'mx-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
            searchOpen
              ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
          ].join(' ')}
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <ContentReferenceMenu
          capabilities={capabilities}
          activeMode={referenceMode}
          onSelectMode={(mode) => setReferenceMode(mode === 'region' ? mode : null)}
          onCancelMode={() => setReferenceMode(null)}
          compact
        />
        {searchOpen ? (
          <FloatingFileSearchControls
            query={searchQuery}
            onQueryChange={setSearchQuery}
            matchIndex={searchMatchIndex}
            matchCount={searchMatches.length}
            onPrevious={() => moveSearch(-1)}
            onNext={() => moveSearch(1)}
            onClose={closeSearch}
            searchLabel={t('builtinOfficePreview.search')}
            placeholder={t('builtinOfficePreview.searchPlaceholder')}
            previousLabel={t('pdfToolbar.previousResult')}
            nextLabel={t('pdfToolbar.nextResult')}
            closeLabel={t('builtinOfficePreview.closeSearch')}
            noMatchesLabel={t('builtinOfficePreview.noMatches')}
          />
        ) : null}
      </div>
      <div className="relative min-h-0 w-full flex-1 overflow-hidden bg-white">
        <div
          ref={containerRef}
          data-testid="spreadsheet-interactive-preview"
          className="h-full min-h-0 w-full overflow-hidden bg-white"
        />
      </div>
      <RegionSelectionOverlay
        active={referenceMode === 'region'}
        hostRef={containerRef}
        resolveTarget={() => {
          const element = containerRef.current;
          if (!element) return null;
          const activeSheet = runtimeRef.current?.api.getActiveWorkbook()?.getActiveSheet();
          return {
            element,
            surface: 'sheet',
            sheetId: activeSheet?.getSheetId() || `sheet-${activeSheetIndex}`,
            sheetName: activeSheet?.getSheetName() || `Sheet ${activeSheetIndex + 1}`,
            anchorRange: selectionDraft?.activeRange,
          };
        }}
        onCommit={handleRegionCommit}
        onCancel={() => setReferenceMode(null)}
      />
    </div>
  );
}
