import { createElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Files,
  ListTree,
  Maximize,
  Maximize2,
  Minimize,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  StretchHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  createDocumentSelectionReference,
  type DocumentSelectionReference,
  type DocumentSelectionSource,
} from '../../../../types/documentSelection';
import type { PdfNavigationMode } from '../../utils/documentPreview';
import { resolvePdfOutline, type PdfOutlineItem } from '../../utils/pdfOutline';
import {
  findPdfSearchMatches,
  renderPdfSearchHighlights,
  type PdfSearchMatch,
} from '../../utils/pdfSearch';

type PdfDocumentPreviewProps = {
  blob?: Blob;
  url?: string;
  projectName?: string;
  fileName: string;
  filePath: string;
  source: DocumentSelectionSource;
  /** Distinguishes multiple PDF views backed by the same source file. */
  viewKey?: string;
  loadingOverlay?: string | null;
  navigationMode?: PdfNavigationMode;
  showPageControls?: boolean;
  onRefresh?: (() => void) | null;
  refreshDisabled?: boolean;
  downloadUrl?: string | null;
  downloadName?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | null;
};

type PdfSelectionAction = {
  top: number;
  left: number;
  reference: DocumentSelectionReference;
};

type PageSize = {
  width: number;
  height: number;
};

type ViewerSize = {
  width: number;
  height: number;
};

type ZoomMode = 'fitPage' | 'fitWidth' | 'custom';
type Rotation = 0 | 90 | 180 | 270;
type NavigationView = 'thumbnails' | 'outline';

type PdfViewState = {
  scrollTop: number;
  currentPage: number;
  zoomMode: ZoomMode;
  customScale: number;
  rotation: Rotation;
};

type ToolbarIconProps = {
  className?: string;
  strokeWidth?: number;
};

type PdfPageProps = {
  pdfDocument: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: Rotation;
  basePageSize: PageSize;
  viewerRootRef: RefObject<HTMLDivElement | null>;
  forceRender: boolean;
  searchMatches: PdfSearchMatch[];
  selectedSearchMatchId: string | null;
  onPageText: (pageNumber: number, text: string, textItems: string[]) => void;
  onPageVisibilityChange: (pageNumber: number, visible: boolean) => void;
};

type PdfThumbnailProps = {
  pdfDocument: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  rotation: Rotation;
  active: boolean;
  navigationRootRef: RefObject<HTMLDivElement | null>;
  label: string;
  onSelect: (pageNumber: number) => void;
};

type PdfOutlineTreeProps = {
  items: PdfOutlineItem[];
  currentPage: number;
  onSelect: (pageNumber: number) => void;
  expandLabel: string;
  collapseLabel: string;
  nested?: boolean;
};

const PAGE_HORIZONTAL_PADDING = 32;
const PAGE_VERTICAL_PADDING = 40;
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.25;
const CONTEXT_RADIUS = 500;
const PDF_RANGE_CHUNK_SIZE = 256 * 1024;
const PAGE_RENDER_ROOT_MARGIN = '1200px 0px';
const THUMBNAIL_RENDER_ROOT_MARGIN = '600px 0px';
const THUMBNAIL_MAX_WIDTH = 116;
const THUMBNAIL_MAX_HEIGHT = 124;

const DEFAULT_VIEW_STATE: PdfViewState = {
  scrollTop: 0,
  currentPage: 1,
  zoomMode: 'fitPage',
  customScale: 1,
  rotation: 0,
};

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function ignorePdfCleanupError(callback: () => unknown): void {
  try {
    const result = callback();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // PDF.js cleanup can throw when a render/load task has already finished or was already cancelled.
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isQuarterTurn(rotation: Rotation): boolean {
  return rotation === 90 || rotation === 270;
}

function getRotatedPageSize(size: PageSize, rotation: Rotation): PageSize {
  return isQuarterTurn(rotation)
    ? { width: size.height, height: size.width }
    : size;
}

function parsePercentInput(value: string): number | null {
  const normalized = value.replace('%', '').trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed / 100, MIN_SCALE, MAX_SCALE);
}

function parsePageInput(value: string, totalPages: number): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(clamp(parsed, 1, Math.max(1, totalPages)));
}

function buildSurroundingText(documentText: string, selectedText: string): string {
  const normalizedDocument = normalizeText(documentText);
  const normalizedSelected = normalizeText(selectedText);
  if (!normalizedDocument || !normalizedSelected) return '';

  const index = normalizedDocument.indexOf(normalizedSelected);
  if (index < 0) return normalizedSelected;

  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(normalizedDocument.length, index + normalizedSelected.length + CONTEXT_RADIUS);
  return normalizedDocument.slice(start, end).trim();
}

function getOccurrenceIndex(documentText: string, selectedText: string): number | null {
  const normalizedDocument = normalizeText(documentText);
  const normalizedSelected = normalizeText(selectedText);
  if (!normalizedDocument || !normalizedSelected) return null;
  return normalizedDocument.includes(normalizedSelected) ? 1 : null;
}

function getSelectedPageNumbers(root: HTMLElement, range: Range): number[] {
  const pages = Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page-number]'));
  return pages
    .filter((page) => {
      try {
        return range.intersectsNode(page);
      } catch {
        return false;
      }
    })
    .map((page) => Number.parseInt(page.dataset.pdfPageNumber || '', 10))
    .filter((pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0);
}

function getTextLayerText(root: HTMLElement, pageNumbers: number[]): string {
  const pages = pageNumbers.length > 0
    ? pageNumbers
      .map((pageNumber) => root.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`))
      .filter((page): page is HTMLElement => Boolean(page))
    : Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page-number]'));

  return pages
    .map((page) => page.querySelector<HTMLElement>('.textLayer')?.textContent || '')
    .filter(Boolean)
    .join('\n');
}

function getClosestElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function renderToolbarIcon(Icon: unknown): ReactNode {
  return createElement(Icon as ComponentType<ToolbarIconProps>, {
    className: 'h-4 w-4',
    strokeWidth: 1.75,
  });
}

function ToolbarButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors',
        'hover:bg-neutral-100 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-40',
        'dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50',
        active ? 'bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-50' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function ToolbarLink({
  title,
  href,
  download,
  children,
}: {
  title: string;
  href: string;
  download?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      download={download}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
    >
      {children}
    </a>
  );
}

function ToolbarSeparator() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />;
}

function PdfThumbnail({
  pdfDocument,
  pageNumber,
  rotation,
  active,
  navigationRootRef,
  label,
  onSelect,
}: PdfThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shouldRender, setShouldRender] = useState(pageNumber <= 3);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    const node = buttonRef.current;
    if (!node || shouldRender) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      {
        root: navigationRootRef.current,
        rootMargin: THUMBNAIL_RENDER_ROOT_MARGIN,
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [navigationRootRef, shouldRender]);

  useEffect(() => {
    if (!active) return;
    buttonRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current) return undefined;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;

    const renderThumbnail = async () => {
      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const baseViewport = page.getViewport({ scale: 1, rotation });
        const scale = Math.min(
          THUMBNAIL_MAX_WIDTH / baseViewport.width,
          THUMBNAIL_MAX_HEIGHT / baseViewport.height,
        );
        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        const outputScale = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (!cancelled) setRenderError(false);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (!cancelled && !message.includes('cancelled')) {
          setRenderError(true);
        }
      }
    };

    void renderThumbnail();
    return () => {
      cancelled = true;
      ignorePdfCleanupError(() => renderTask?.cancel?.());
    };
  }, [pageNumber, pdfDocument, rotation, shouldRender]);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-pdf-thumbnail-page={pageNumber}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      onClick={() => onSelect(pageNumber)}
      className={[
        'group flex w-full flex-col items-center gap-1.5 rounded-md border px-2 py-2 text-[11px] outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-neutral-950',
        active
          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-200'
          : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:bg-neutral-900',
      ].join(' ')}
    >
      <span className="flex h-[124px] w-full items-center justify-center overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-neutral-200 dark:ring-neutral-700">
        {renderError ? (
          <span className="px-2 text-center text-[10px] text-red-500">!</span>
        ) : (
          <canvas ref={canvasRef} className="block max-h-full max-w-full" />
        )}
      </span>
      <span className="font-medium tabular-nums">{pageNumber}</span>
    </button>
  );
}

function PdfOutlineTree({
  items,
  currentPage,
  onSelect,
  expandLabel,
  collapseLabel,
  nested = false,
}: PdfOutlineTreeProps) {
  return (
    <ul role={nested ? 'group' : 'tree'} className="space-y-0.5">
      {items.map((item) => (
        <PdfOutlineTreeItem
          key={item.id}
          item={item}
          currentPage={currentPage}
          onSelect={onSelect}
          expandLabel={expandLabel}
          collapseLabel={collapseLabel}
        />
      ))}
    </ul>
  );
}

function PdfOutlineTreeItem({
  item,
  currentPage,
  onSelect,
  expandLabel,
  collapseLabel,
}: {
  item: PdfOutlineItem;
  currentPage: number;
  onSelect: (pageNumber: number) => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  const hasChildren = item.items.length > 0;
  const [expanded, setExpanded] = useState(true);
  const active = item.pageNumber === currentPage;

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <div
        className={[
          'group flex min-h-8 items-start rounded-md text-[12px] transition-colors',
          active
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200'
            : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900',
        ].join(' ')}
      >
        {hasChildren ? (
          <button
            type="button"
            title={expanded ? collapseLabel : expandLabel}
            aria-label={expanded ? collapseLabel : expandLabel}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-8 w-7 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
          >
            {renderToolbarIcon(expanded ? ChevronDown : ChevronRight)}
          </button>
        ) : (
          <span className="w-7 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          disabled={item.pageNumber === null}
          title={item.title}
          onClick={() => {
            if (item.pageNumber !== null) onSelect(item.pageNumber);
          }}
          className="min-w-0 flex-1 py-1.5 pr-2 text-left leading-5 disabled:cursor-default"
        >
          <span className="line-clamp-2">{item.title}</span>
        </button>
      </div>
      {hasChildren && expanded ? (
        <div className="ml-3 border-l border-neutral-200 pl-1 dark:border-neutral-800">
          <PdfOutlineTree
            items={item.items}
            currentPage={currentPage}
            onSelect={onSelect}
            expandLabel={expandLabel}
            collapseLabel={collapseLabel}
            nested
          />
        </div>
      ) : null}
    </li>
  );
}

function PdfPage({
  pdfDocument,
  pageNumber,
  scale,
  rotation,
  basePageSize,
  viewerRootRef,
  forceRender,
  searchMatches,
  selectedSearchMatchId,
  onPageText,
  onPageVisibilityChange,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerMappingRef = useRef<{
    textDivs: HTMLElement[];
    textItems: string[];
  } | null>(null);
  const [isIntersectionVisible, setIsIntersectionVisible] = useState(false);
  const estimatedPageSize = useMemo(() => {
    const rotated = getRotatedPageSize(basePageSize, rotation);
    return {
      width: Math.max(1, rotated.width * scale),
      height: Math.max(1, rotated.height * scale),
      scale,
    };
  }, [basePageSize, rotation, scale]);
  const [pageSize, setPageSize] = useState(estimatedPageSize);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [textLayerRenderVersion, setTextLayerRenderVersion] = useState(0);
  const shouldRender = isIntersectionVisible || forceRender;

  useEffect(() => {
    setPageSize(estimatedPageSize);
  }, [estimatedPageSize]);

  useEffect(() => {
    const node = pageRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const nextVisible = entries.some((entry) => entry.isIntersecting);
        setIsIntersectionVisible(nextVisible);
        onPageVisibilityChange(pageNumber, nextVisible);
      },
      {
        root: viewerRootRef.current,
        rootMargin: PAGE_RENDER_ROOT_MARGIN,
      },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      onPageVisibilityChange(pageNumber, false);
    };
  }, [onPageVisibilityChange, pageNumber, viewerRootRef]);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current || !textLayerRef.current || scale <= 0) {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.style.width = '';
        canvas.style.height = '';
      }
      textLayerRef.current?.replaceChildren();
      textLayerMappingRef.current = null;
      setRenderError(null);
      setIsRendering(false);
      setHasRendered(false);
      return undefined;
    }

    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;

    const renderPage = async () => {
      try {
        setRenderError(null);
        setIsRendering(true);
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        const textLayerContainer = textLayerRef.current;
        if (!canvas || !textLayerContainer) return;

        const outputScale = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height, scale });

        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        textLayerContainer.replaceChildren();
        textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) {
          const textItems = textLayer.textContentItemsStr;
          textLayerMappingRef.current = {
            textDivs: textLayer.textDivs,
            textItems,
          };
          onPageText(pageNumber, textItems.join(' '), textItems);
          setTextLayerRenderVersion((version) => version + 1);
          setHasRendered(true);
          setIsRendering(false);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          const name = error instanceof Error ? error.name : '';
          if (name !== 'RenderingCancelledException' && !message.toLowerCase().includes('cancelled')) {
            setRenderError(message);
          }
          setIsRendering(false);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      ignorePdfCleanupError(() => renderTask?.cancel?.());
      ignorePdfCleanupError(() => textLayer?.cancel?.());
    };
  }, [shouldRender, onPageText, pageNumber, pdfDocument, rotation, scale]);

  useEffect(() => {
    const mapping = textLayerMappingRef.current;
    if (!mapping || textLayerRenderVersion === 0) return undefined;

    const selectedElement = renderPdfSearchHighlights(
      mapping.textDivs,
      mapping.textItems,
      searchMatches,
      selectedSearchMatchId,
    );
    if (!selectedElement) return undefined;

    const frame = window.requestAnimationFrame(() => {
      selectedElement.scrollIntoView({
        block: 'center',
        inline: 'center',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchMatches, selectedSearchMatchId, textLayerRenderVersion]);

  const pageStyle = {
    width: pageSize.width,
    height: pageSize.height,
    '--scale-factor': pageSize.scale,
    '--user-unit': 1,
    '--total-scale-factor': pageSize.scale,
  } as CSSProperties;

  return (
    <div
      ref={pageRef}
      data-pdf-page-number={pageNumber}
      className="relative mx-auto my-5 bg-white shadow-sm ring-1 ring-neutral-200 dark:ring-neutral-800"
      style={pageStyle}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
      {shouldRender && (isRendering || !hasRendered) && !renderError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-neutral-950">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-500 dark:border-neutral-800 dark:border-t-neutral-300" />
        </div>
      ) : null}
      {renderError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-4 text-center text-[12px] text-red-500 dark:bg-neutral-950/90">
          {renderError}
        </div>
      ) : null}
    </div>
  );
}

export default function PdfDocumentPreview({
  blob,
  url,
  projectName,
  fileName,
  filePath,
  source,
  viewKey = '',
  loadingOverlay = null,
  navigationMode = 'none',
  showPageControls = true,
  onRefresh = null,
  refreshDisabled = false,
  downloadUrl = null,
  downloadName,
  isFullscreen = false,
  onToggleFullscreen = null,
}: PdfDocumentPreviewProps) {
  const { t } = useTranslation('codeEditor');
  const inputId = useId();
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pageTextRef = useRef(new Map<number, string>());
  const pageTextItemsRef = useRef(new Map<number, string[]>());
  const visiblePageNumbersRef = useRef(new Set<number>());
  const forcedRenderPageNumbersRef = useRef(new Set<number>());
  const scrollRafRef = useRef<number | null>(null);
  const renderFallbackRafRef = useRef<number | null>(null);
  const selectionActionTimerRef = useRef<number | null>(null);
  const searchRequestIdRef = useRef(0);
  const viewStateRef = useRef<PdfViewState>({ ...DEFAULT_VIEW_STATE });
  const fileKeyRef = useRef<string | null>(null);
  const pendingRestoreRef = useRef<PdfViewState | null>(null);
  const [pdfDocument, setPdfDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [firstPageSize, setFirstPageSize] = useState<PageSize | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewerSize, setViewerSize] = useState<ViewerSize>({ width: 0, height: 0 });
  const [selectionAction, setSelectionAction] = useState<PdfSelectionAction | null>(null);
  const [forcedRenderPageNumbers, setForcedRenderPageNumbers] = useState<Set<number>>(() => new Set());
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fitPage');
  const [customScale, setCustomScale] = useState(1);
  const [zoomInput, setZoomInput] = useState('100%');
  const [zoomInputFocused, setZoomInputFocused] = useState(false);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageInputFocused, setPageInputFocused] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(navigationMode !== 'none');
  const [navigationView, setNavigationView] = useState<NavigationView>('thumbnails');
  const [outlineItems, setOutlineItems] = useState<PdfOutlineItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PdfSearchMatch[]>([]);
  const [searchResultIndex, setSearchResultIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [searchCompleted, setSearchCompleted] = useState(false);
  const navigationRef = useRef<HTMLDivElement | null>(null);
  const fileKey = `${source}:${projectName || ''}:${filePath}:${viewKey}`;

  useEffect(() => {
    viewStateRef.current.currentPage = currentPage;
  }, [currentPage]);

  useEffect(() => {
    viewStateRef.current.zoomMode = zoomMode;
  }, [zoomMode]);

  useEffect(() => {
    viewStateRef.current.customScale = customScale;
  }, [customScale]);

  useEffect(() => {
    viewStateRef.current.rotation = rotation;
  }, [rotation]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return undefined;
    const updateSize = () => {
      setViewerSize({
        width: viewer.clientWidth,
        height: viewer.clientHeight,
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    const viewer = viewerRef.current;
    const isSameFile = fileKeyRef.current === fileKey;
    const nextViewState = isSameFile
      ? {
        ...viewStateRef.current,
        scrollTop: viewer?.scrollTop ?? viewStateRef.current.scrollTop,
      }
      : { ...DEFAULT_VIEW_STATE };
    fileKeyRef.current = fileKey;
    pendingRestoreRef.current = nextViewState;
    viewStateRef.current = nextViewState;
    pageTextRef.current = new Map();
    pageTextItemsRef.current = new Map();
    visiblePageNumbersRef.current = new Set();
    forcedRenderPageNumbersRef.current = new Set();
    setForcedRenderPageNumbers(new Set());
    setPdfDocument(null);
    setFirstPageSize(null);
    setErrorMessage(null);
    setSelectionAction(null);
    setCurrentPage(nextViewState.currentPage);
    setPageInput(String(nextViewState.currentPage));
    setRotation(nextViewState.rotation);
    setZoomMode(nextViewState.zoomMode);
    setCustomScale(nextViewState.customScale);
    setNavigationOpen(navigationMode !== 'none');
    setNavigationView('thumbnails');
    setOutlineItems([]);
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchResultIndex(-1);
    setSearching(false);
    setSearchCompleted(false);
    searchRequestIdRef.current += 1;

    const loadPdf = async () => {
      try {
        if (!url && !blob) {
          throw new Error('PDF source is not available.');
        }

        if (url) {
          loadingTask = pdfjs.getDocument({
            url,
            rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
            disableStream: true,
            disableAutoFetch: true,
          });
        } else {
          const data = new Uint8Array(await blob!.arrayBuffer());
          if (cancelled) return;
          loadingTask = pdfjs.getDocument({ data });
        }

        const nextDocument = await loadingTask.promise;
        if (cancelled) return;
        const restoredPage = clamp(
          nextViewState.currentPage,
          1,
          Math.max(1, nextDocument.numPages),
        );
        if (restoredPage !== nextViewState.currentPage) {
          const clampedViewState = {
            ...nextViewState,
            currentPage: restoredPage,
            scrollTop: 0,
          };
          pendingRestoreRef.current = clampedViewState;
          viewStateRef.current = clampedViewState;
          setCurrentPage(restoredPage);
          setPageInput(String(restoredPage));
        }
        const firstPage = await nextDocument.getPage(1);
        if (cancelled) return;
        const viewport = firstPage.getViewport({ scale: 1 });
        setFirstPageSize({ width: viewport.width, height: viewport.height });
        setPdfDocument(nextDocument);
        if (navigationMode === 'pages') {
          try {
            const rawOutline = await nextDocument.getOutline();
            const nextOutlineItems = await resolvePdfOutline(nextDocument, rawOutline);
            if (cancelled) return;
            setOutlineItems(nextOutlineItems);
            if (nextOutlineItems.length > 0) {
              setNavigationView('outline');
            }
          } catch {
            if (!cancelled) {
              setOutlineItems([]);
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }
    };

    loadPdf();
    return () => {
      cancelled = true;
      ignorePdfCleanupError(() => loadingTask?.destroy?.());
    };
  }, [blob, fileKey, navigationMode, url]);

  const fitScales = useMemo(() => {
    if (!firstPageSize || viewerSize.width <= 0 || viewerSize.height <= 0) {
      return { fitWidth: 1, fitPage: 1 };
    }
    const rotatedSize = getRotatedPageSize(firstPageSize, rotation);
    const availableWidth = Math.max(1, viewerSize.width - PAGE_HORIZONTAL_PADDING * 2);
    const availableHeight = Math.max(1, viewerSize.height - PAGE_VERTICAL_PADDING);
    const fitWidth = availableWidth / rotatedSize.width;
    const fitPage = Math.min(fitWidth, availableHeight / rotatedSize.height);
    return {
      fitWidth: clamp(fitWidth, MIN_SCALE, MAX_SCALE),
      fitPage: clamp(fitPage, MIN_SCALE, MAX_SCALE),
    };
  }, [firstPageSize, rotation, viewerSize.height, viewerSize.width]);

  const activeScale = zoomMode === 'fitWidth'
    ? fitScales.fitWidth
    : zoomMode === 'fitPage'
      ? fitScales.fitPage
      : customScale;

  const zoomPercent = Math.round(activeScale * 100);

  useEffect(() => {
    if (!zoomInputFocused) {
      setZoomInput(`${zoomPercent}%`);
    }
  }, [zoomInputFocused, zoomPercent]);

  useEffect(() => {
    if (!pageInputFocused) {
      setPageInput(String(currentPage));
    }
  }, [currentPage, pageInputFocused]);

  const updateCurrentPageFromScroll = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const visiblePageNumbers = Array.from(new Set([
      ...visiblePageNumbersRef.current,
      ...forcedRenderPageNumbersRef.current,
    ]))
      .sort((left, right) => left - right);
    const pages = visiblePageNumbers.length > 0
      ? visiblePageNumbers
        .map((pageNumber) => viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`))
        .filter((page): page is HTMLElement => Boolean(page))
      : Array.from(viewer.querySelectorAll<HTMLElement>('[data-pdf-page-number]'));
    if (pages.length === 0) return;

    const viewerRect = viewer.getBoundingClientRect();
    let bestPage: number | null = null;
    let bestVisibleHeight = 0;
    let bestTopDistance = Number.POSITIVE_INFINITY;

    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top),
      );
      const topDistance = Math.abs(rect.top - viewerRect.top);
      const isBetterCandidate = visibleHeight > bestVisibleHeight
        || (visibleHeight === bestVisibleHeight && topDistance < bestTopDistance);
      if (!isBetterCandidate) continue;

      const pageNumber = Number.parseInt(page.dataset.pdfPageNumber || '', 10);
      if (Number.isFinite(pageNumber) && pageNumber > 0) {
        bestPage = pageNumber;
        bestVisibleHeight = visibleHeight;
        bestTopDistance = topDistance;
      }
    }

    if (bestPage !== null) {
      setCurrentPage((previousPage) => (previousPage === bestPage ? previousPage : bestPage));
    }
  }, []);

  const scheduleCurrentPageUpdate = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateCurrentPageFromScroll();
    });
  }, [updateCurrentPageFromScroll]);

  const updateForcedRenderPages = useCallback(() => {
    const viewer = viewerRef.current;
    const totalPages = pdfDocument?.numPages || 0;
    if (!viewer || totalPages <= 0) {
      forcedRenderPageNumbersRef.current = new Set();
      setForcedRenderPageNumbers(new Set());
      return;
    }

    const viewerRect = viewer.getBoundingClientRect();
    const viewportTop = viewerRect.top - 1200;
    const viewportBottom = viewerRect.bottom + 1200;
    const nextPages = new Set<number>();
    const pages = Array.from(viewer.querySelectorAll<HTMLElement>('[data-pdf-page-number]'));

    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const pageNumber = Number.parseInt(page.dataset.pdfPageNumber || '', 10);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;
      if (rect.bottom >= viewportTop && rect.top <= viewportBottom) {
        nextPages.add(pageNumber);
      }
    }

    if (nextPages.size === 0) {
      nextPages.add(clamp(viewStateRef.current.currentPage, 1, totalPages));
    }

    forcedRenderPageNumbersRef.current = nextPages;
    setForcedRenderPageNumbers((previous) => {
      if (previous.size === nextPages.size && Array.from(previous).every((pageNumber) => nextPages.has(pageNumber))) {
        return previous;
      }
      return nextPages;
    });
  }, [pdfDocument?.numPages]);

  const scheduleForcedRenderUpdate = useCallback(() => {
    if (renderFallbackRafRef.current !== null) return;
    renderFallbackRafRef.current = window.requestAnimationFrame(() => {
      renderFallbackRafRef.current = null;
      updateForcedRenderPages();
    });
  }, [updateForcedRenderPages]);

  useEffect(() => () => {
    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (renderFallbackRafRef.current !== null) {
      window.cancelAnimationFrame(renderFallbackRafRef.current);
      renderFallbackRafRef.current = null;
    }
  }, []);

  const handlePageVisibilityChange = useCallback((pageNumber: number, visible: boolean) => {
    if (visible) {
      visiblePageNumbersRef.current.add(pageNumber);
    } else {
      visiblePageNumbersRef.current.delete(pageNumber);
    }
    scheduleForcedRenderUpdate();
    scheduleCurrentPageUpdate();
  }, [scheduleCurrentPageUpdate, scheduleForcedRenderUpdate]);

  const handlePageText = useCallback((pageNumber: number, text: string, textItems: string[]) => {
    pageTextRef.current.set(pageNumber, text);
    pageTextItemsRef.current.set(pageNumber, textItems);
  }, []);

  const jumpToPage = useCallback((pageNumber: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const target = viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`);
    if (target) {
      const viewerRect = viewer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      viewer.scrollTo({
        top: viewer.scrollTop + targetRect.top - viewerRect.top - 12,
      });
    }
    setCurrentPage(pageNumber);
  }, []);

  const goToSearchResult = useCallback((index: number, results = searchResults) => {
    if (results.length === 0) {
      setSearchResultIndex(-1);
      return;
    }
    const nextIndex = (index + results.length) % results.length;
    const pageNumber = results[nextIndex].pageNumber;
    forcedRenderPageNumbersRef.current.add(pageNumber);
    setForcedRenderPageNumbers(new Set(forcedRenderPageNumbersRef.current));
    setSearchResultIndex(nextIndex);
    jumpToPage(pageNumber);
  }, [jumpToPage, searchResults]);

  const runSearch = useCallback(async () => {
    const document = pdfDocument;
    const query = normalizeText(searchQuery);
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setSearchCompleted(false);

    if (!document || !query) {
      setSearchResults([]);
      setSearchResultIndex(-1);
      setSearching(false);
      return;
    }

    setSearching(true);
    const nextResults: PdfSearchMatch[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (searchRequestIdRef.current !== requestId) return;
        let textItems = pageTextItemsRef.current.get(pageNumber);
        if (textItems === undefined) {
          const page = await document.getPage(pageNumber);
          const textContent = await page.getTextContent();
          textItems = textContent.items
            .map((item) => ('str' in item ? item.str : ''))
            .filter(Boolean);
          pageTextItemsRef.current.set(pageNumber, textItems);
          pageTextRef.current.set(pageNumber, textItems.join(' '));
        }
        nextResults.push(...findPdfSearchMatches(textItems, query, pageNumber));
      }
    } catch {
      nextResults.length = 0;
    } finally {
      if (searchRequestIdRef.current === requestId) {
        setSearching(false);
        setSearchCompleted(true);
        setSearchResults(nextResults);
        if (nextResults.length > 0) {
          goToSearchResult(0, nextResults);
        } else {
          setSearchResultIndex(-1);
        }
      }
    }
  }, [goToSearchResult, pdfDocument, searchQuery]);

  const closeSearch = useCallback(() => {
    searchRequestIdRef.current += 1;
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchResultIndex(-1);
    setSearching(false);
    setSearchCompleted(false);
  }, []);

  const commitPageInput = useCallback(() => {
    const totalPages = pdfDocument?.numPages || 1;
    const parsed = parsePageInput(pageInput, totalPages);
    if (!parsed) {
      setPageInput(String(currentPage));
      return;
    }
    setPageInput(String(parsed));
    jumpToPage(parsed);
  }, [currentPage, jumpToPage, pageInput, pdfDocument?.numPages]);

  const commitZoomInput = useCallback(() => {
    const parsed = parsePercentInput(zoomInput);
    if (!parsed) {
      setZoomInput(`${zoomPercent}%`);
      return;
    }
    setCustomScale(parsed);
    setZoomMode('custom');
    setZoomInput(`${Math.round(parsed * 100)}%`);
  }, [zoomInput, zoomPercent]);

  const setCustomZoomFromScale = useCallback((nextScale: number) => {
    const next = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    setCustomScale(next);
    setZoomMode('custom');
    setZoomInput(`${Math.round(next * 100)}%`);
  }, []);

  const updateSelectionAction = useCallback(() => {
    const viewer = viewerRef.current;
    const selection = window.getSelection();
    if (!viewer || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionAction(null);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !viewer.contains(anchorNode) || !viewer.contains(focusNode)) {
      setSelectionAction(null);
      return;
    }

    const anchorElement = getClosestElement(anchorNode);
    const focusElement = getClosestElement(focusNode);
    if (!anchorElement?.closest('.textLayer') || !focusElement?.closest('.textLayer')) {
      setSelectionAction(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      setSelectionAction(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    const viewerRect = viewer.getBoundingClientRect();
    const pageNumbers = getSelectedPageNumbers(viewer, range);
    const sortedPageTexts = Array.from(pageTextRef.current.entries())
      .sort(([left], [right]) => left - right);
    const cachedDocumentText = sortedPageTexts.map(([, text]) => text).join('\n');
    const cachedPageText = pageNumbers.length > 0
      ? pageNumbers.map((pageNumber) => pageTextRef.current.get(pageNumber) || '').join('\n')
      : cachedDocumentText;
    const domPageText = getTextLayerText(viewer, pageNumbers);
    const contextText = domPageText || cachedPageText || cachedDocumentText || selectedText;
    const surroundingText = buildSurroundingText(contextText, selectedText);
    const occurrenceIndex = getOccurrenceIndex(cachedDocumentText || contextText, selectedText);
    const reference = createDocumentSelectionReference({
      projectName,
      fileName,
      filePath,
      source,
      pageNumbers,
      selectedText,
      surroundingText,
      occurrenceIndex,
    });

    const left = Math.max(12, Math.min(viewer.clientWidth - 190, rect.left - viewerRect.left + viewer.scrollLeft + rect.width / 2 - 80));
    const top = Math.max(12, rect.top - viewerRect.top + viewer.scrollTop - 42);
    setSelectionAction({ top, left, reference });
  }, [fileName, filePath, projectName, source]);

  const cancelScheduledSelectionAction = useCallback(() => {
    if (selectionActionTimerRef.current !== null) {
      window.clearTimeout(selectionActionTimerRef.current);
      selectionActionTimerRef.current = null;
    }
  }, []);

  const scheduleSelectionAction = useCallback(() => {
    cancelScheduledSelectionAction();
    selectionActionTimerRef.current = window.setTimeout(() => {
      selectionActionTimerRef.current = null;
      updateSelectionAction();
    }, 40);
  }, [cancelScheduledSelectionAction, updateSelectionAction]);

  useEffect(() => {
    const handleSelectionChange = () => setSelectionAction(null);
    const handleScroll = () => {
      const viewer = viewerRef.current;
      if (viewer) {
        viewStateRef.current.scrollTop = viewer.scrollTop;
      }
      cancelScheduledSelectionAction();
      setSelectionAction(null);
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', scheduleSelectionAction);
    document.addEventListener('touchend', scheduleSelectionAction);
    document.addEventListener('keyup', scheduleSelectionAction);
    const viewer = viewerRef.current;
    viewer?.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      cancelScheduledSelectionAction();
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', scheduleSelectionAction);
      document.removeEventListener('touchend', scheduleSelectionAction);
      document.removeEventListener('keyup', scheduleSelectionAction);
      viewer?.removeEventListener('scroll', handleScroll);
    };
  }, [cancelScheduledSelectionAction, scheduleCurrentPageUpdate, scheduleForcedRenderUpdate, scheduleSelectionAction]);

  useEffect(() => {
    scheduleForcedRenderUpdate();
    scheduleCurrentPageUpdate();
  }, [activeScale, rotation, pdfDocument, scheduleCurrentPageUpdate, scheduleForcedRenderUpdate, viewerSize.height, viewerSize.width]);

  useEffect(() => {
    if (!pdfDocument || !firstPageSize) return undefined;
    const restoreState = pendingRestoreRef.current;
    if (!restoreState) {
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (viewer) {
        if (restoreState.scrollTop > 0) {
          viewer.scrollTop = restoreState.scrollTop;
        } else if (restoreState.currentPage > 1) {
          const target = viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${restoreState.currentPage}"]`);
          target?.scrollIntoView({ block: 'start' });
        } else {
          viewer.scrollTop = 0;
        }
        viewStateRef.current.scrollTop = viewer.scrollTop;
      }
      setCurrentPage(restoreState.currentPage);
      setPageInput(String(restoreState.currentPage));
      pendingRestoreRef.current = null;
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [firstPageSize, pdfDocument, scheduleCurrentPageUpdate, scheduleForcedRenderUpdate]);

  const handleAddReference = () => {
    if (!selectionAction) return;
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', {
      detail: selectionAction.reference,
    }));
    window.getSelection()?.removeAllRanges();
    setSelectionAction(null);
  };

  const searchMatchesByPage = useMemo(() => {
    const matchesByPage = new Map<number, PdfSearchMatch[]>();
    searchResults.forEach((match) => {
      const pageMatches = matchesByPage.get(match.pageNumber) || [];
      pageMatches.push(match);
      matchesByPage.set(match.pageNumber, pageMatches);
    });
    return matchesByPage;
  }, [searchResults]);
  const selectedSearchMatchId = searchResultIndex >= 0
    ? searchResults[searchResultIndex]?.id || null
    : null;

  if (errorMessage) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white p-6 text-center text-[13px] text-red-500 dark:bg-neutral-950">
        {errorMessage}
      </div>
    );
  }

  const totalPages = pdfDocument?.numPages || 0;
  const canZoomOut = activeScale > MIN_SCALE;
  const canZoomIn = activeScale < MAX_SCALE;
  const readyDocument = pdfDocument && firstPageSize
    ? { pdfDocument, firstPageSize }
    : null;
  const isLoaded = Boolean(readyDocument);
  const zoomInputId = `${inputId}-pdf-zoom`;
  const pageInputId = `${inputId}-pdf-page`;
  const searchInputId = `${inputId}-pdf-search`;
  const navigationLabel = navigationMode === 'slides'
    ? t('pdfToolbar.slides')
    : t('pdfToolbar.pages');
  const hasOutline = navigationMode === 'pages' && outlineItems.length > 0;
  const currentLocationLabel = navigationMode === 'slides'
    ? t('pdfToolbar.slideNumber')
    : t('pdfToolbar.pageNumber');
  const goToLocationLabel = navigationMode === 'slides'
    ? t('pdfToolbar.goToSlide')
    : t('pdfToolbar.goToPage');
  const locationOfLabel = navigationMode === 'slides'
    ? t('pdfToolbar.slideOf', { total: totalPages || '-' })
    : t('pdfToolbar.pageOf', { total: totalPages || '-' });
  const searchStatus = searching
    ? t('pdfToolbar.searching')
    : searchCompleted
      ? searchResults.length > 0
        ? t('pdfToolbar.resultOf', {
          current: searchResultIndex + 1,
          total: searchResults.length,
        })
        : t('pdfToolbar.noResults')
      : '';
  return (
    <div className="flex h-full w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      <div className="scrollbar-hide flex min-h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-neutral-200 bg-white px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-950">
        {navigationMode !== 'none' ? (
          <>
            <ToolbarButton
              title={navigationOpen ? t('pdfToolbar.hideNavigation') : t('pdfToolbar.showNavigation')}
              active={navigationOpen}
              disabled={!isLoaded}
              onClick={() => setNavigationOpen((open) => !open)}
            >
              {renderToolbarIcon(PanelLeft)}
            </ToolbarButton>
            <ToolbarSeparator />
          </>
        ) : null}
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarButton
            title={t('pdfToolbar.zoomOut')}
            disabled={!isLoaded || !canZoomOut}
            onClick={() => setCustomZoomFromScale(activeScale - ZOOM_STEP)}
          >
            {renderToolbarIcon(ZoomOut)}
          </ToolbarButton>
          <label className="sr-only" htmlFor={zoomInputId}>
            {t('pdfToolbar.zoomPercent')}
          </label>
          <input
            id={zoomInputId}
            value={zoomInput}
            disabled={!isLoaded}
            inputMode="numeric"
            aria-label={t('pdfToolbar.zoomPercent')}
            onFocus={(event) => {
              setZoomInputFocused(true);
              event.currentTarget.select();
            }}
            onChange={(event) => setZoomInput(event.target.value)}
            onBlur={() => {
              commitZoomInput();
              setZoomInputFocused(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                setZoomInput(`${zoomPercent}%`);
                event.currentTarget.blur();
              }
            }}
            className="h-8 w-16 rounded-md border border-neutral-200 bg-white px-2 text-center text-[12px] text-neutral-800 outline-none transition focus:border-neutral-400 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-neutral-600"
          />
          <ToolbarButton
            title={t('pdfToolbar.zoomIn')}
            disabled={!isLoaded || !canZoomIn}
            onClick={() => setCustomZoomFromScale(activeScale + ZOOM_STEP)}
          >
            {renderToolbarIcon(ZoomIn)}
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton
            title={t('pdfToolbar.fitWidth')}
            active={zoomMode === 'fitWidth'}
            disabled={!isLoaded}
            onClick={() => setZoomMode('fitWidth')}
          >
            {renderToolbarIcon(StretchHorizontal)}
          </ToolbarButton>
          <ToolbarButton
            title={t('pdfToolbar.fitPage')}
            active={zoomMode === 'fitPage'}
            disabled={!isLoaded}
            onClick={() => setZoomMode('fitPage')}
          >
            {renderToolbarIcon(Maximize2)}
          </ToolbarButton>
          {source === 'pdf' ? (
            <>
              <ToolbarButton
                title={t('pdfToolbar.rotateCounterClockwise')}
                disabled={!isLoaded}
                onClick={() => setRotation((value) => ((value + 270) % 360) as Rotation)}
              >
                {renderToolbarIcon(RotateCcw)}
              </ToolbarButton>
              <ToolbarButton
                title={t('pdfToolbar.rotateClockwise')}
                disabled={!isLoaded}
                onClick={() => setRotation((value) => ((value + 90) % 360) as Rotation)}
              >
                {renderToolbarIcon(RotateCw)}
              </ToolbarButton>
            </>
          ) : null}
        </div>
        {showPageControls ? (
          <>
            <ToolbarSeparator />
            <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
              <label className="sr-only" htmlFor={pageInputId}>
                {currentLocationLabel}
              </label>
              <input
                id={pageInputId}
                value={pageInput}
                disabled={!isLoaded}
                inputMode="numeric"
                aria-label={goToLocationLabel}
                onFocus={(event) => {
                  setPageInputFocused(true);
                  event.currentTarget.select();
                }}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={() => {
                  commitPageInput();
                  setPageInputFocused(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  } else if (event.key === 'Escape') {
                    setPageInput(String(currentPage));
                    event.currentTarget.blur();
                  }
                }}
                className="h-8 w-12 rounded-md border border-neutral-200 bg-white px-1.5 text-center text-[12px] text-neutral-800 outline-none transition focus:border-neutral-400 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-neutral-600"
              />
              <span className="whitespace-nowrap">{locationOfLabel}</span>
            </div>
          </>
        ) : null}
        <ToolbarSeparator />
        <ToolbarButton
          title={t('pdfToolbar.search')}
          active={searchOpen}
          disabled={!isLoaded}
          onClick={() => {
            if (searchOpen) {
              closeSearch();
            } else {
              setSearchOpen(true);
              window.requestAnimationFrame(() => {
                document.getElementById(searchInputId)?.focus();
              });
            }
          }}
        >
          {renderToolbarIcon(Search)}
        </ToolbarButton>
        {searchOpen ? (
          <div role="search" className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-white p-0.5 dark:border-neutral-800 dark:bg-neutral-950">
            <label className="sr-only" htmlFor={searchInputId}>
              {t('pdfToolbar.search')}
            </label>
            <input
              id={searchInputId}
              value={searchQuery}
              placeholder={t('pdfToolbar.searchPlaceholder')}
              onChange={(event) => {
                // Changing the query invalidates any in-flight search immediately.
                // Otherwise a slow search for the previous query can repopulate
                // stale results before the user submits the new value.
                searchRequestIdRef.current += 1;
                setSearchQuery(event.target.value);
                setSearchResults([]);
                setSearchResultIndex(-1);
                setSearching(false);
                setSearchCompleted(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runSearch();
                } else if (event.key === 'Escape') {
                  closeSearch();
                }
              }}
              className="h-7 w-40 bg-transparent px-2 text-[12px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-600"
            />
            <span className="min-w-12 whitespace-nowrap text-center text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              {searchStatus}
            </span>
            <ToolbarButton
              title={t('pdfToolbar.previousResult')}
              disabled={searchResults.length === 0}
              onClick={() => goToSearchResult(searchResultIndex - 1)}
            >
              {renderToolbarIcon(ChevronLeft)}
            </ToolbarButton>
            <ToolbarButton
              title={t('pdfToolbar.nextResult')}
              disabled={searchResults.length === 0}
              onClick={() => goToSearchResult(searchResultIndex + 1)}
            >
              {renderToolbarIcon(ChevronRight)}
            </ToolbarButton>
            <ToolbarButton title={t('pdfToolbar.closeSearch')} onClick={closeSearch}>
              {renderToolbarIcon(X)}
            </ToolbarButton>
          </div>
        ) : null}
        {(onRefresh || onToggleFullscreen || downloadUrl) ? <ToolbarSeparator /> : null}
        {onRefresh ? (
          <ToolbarButton
            title={t('pdfToolbar.refresh')}
            disabled={refreshDisabled}
            onClick={onRefresh}
          >
            <span className={refreshDisabled ? 'animate-spin' : ''}>
              {renderToolbarIcon(RefreshCw)}
            </span>
          </ToolbarButton>
        ) : null}
        {onToggleFullscreen ? (
          <ToolbarButton
            title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
            onClick={onToggleFullscreen}
          >
            {renderToolbarIcon(isFullscreen ? Minimize : Maximize)}
          </ToolbarButton>
        ) : null}
        {downloadUrl ? (
          <ToolbarLink
            title={t('actions.download')}
            href={downloadUrl}
            download={downloadName}
          >
            {renderToolbarIcon(Download)}
          </ToolbarLink>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        {navigationMode !== 'none' && navigationOpen ? (
          <aside className={[
            'flex shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950',
            hasOutline ? 'w-64' : 'w-40',
          ].join(' ')}>
            <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-2 text-[11px] font-medium text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
              {hasOutline ? (
                <div className="flex items-center rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-900">
                  <button
                    type="button"
                    aria-pressed={navigationView === 'thumbnails'}
                    title={t('pdfToolbar.pages')}
                    onClick={() => setNavigationView('thumbnails')}
                    className={[
                      'flex h-7 items-center gap-1.5 rounded px-2 transition-colors',
                      navigationView === 'thumbnails'
                        ? 'bg-white text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-neutral-50'
                        : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
                    ].join(' ')}
                  >
                    {renderToolbarIcon(Files)}
                    <span>{t('pdfToolbar.pages')}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={navigationView === 'outline'}
                    title={t('pdfToolbar.outline')}
                    onClick={() => setNavigationView('outline')}
                    className={[
                      'flex h-7 items-center gap-1.5 rounded px-2 transition-colors',
                      navigationView === 'outline'
                        ? 'bg-white text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-neutral-50'
                        : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
                    ].join(' ')}
                  >
                    {renderToolbarIcon(ListTree)}
                    <span>{t('pdfToolbar.outline')}</span>
                  </button>
                </div>
              ) : (
                <span>{navigationLabel}</span>
              )}
              <span className="tabular-nums text-neutral-400 dark:text-neutral-500">{totalPages || '-'}</span>
            </div>
            <div
              ref={navigationRef}
              role="navigation"
              aria-label={navigationView === 'outline' ? t('pdfToolbar.outline') : navigationLabel}
              className={[
                'scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2',
                navigationView === 'thumbnails' ? 'space-y-2' : '',
              ].join(' ')}
            >
              {readyDocument && navigationView === 'outline' && hasOutline ? (
                <PdfOutlineTree
                  items={outlineItems}
                  currentPage={currentPage}
                  onSelect={jumpToPage}
                  expandLabel={t('pdfToolbar.expandOutline')}
                  collapseLabel={t('pdfToolbar.collapseOutline')}
                />
              ) : null}
              {readyDocument && navigationView === 'thumbnails'
                ? Array.from({ length: readyDocument.pdfDocument.numPages }, (_, index) => {
                  const pageNumber = index + 1;
                  const thumbnailLabel = navigationMode === 'slides'
                    ? t('pdfToolbar.slideLabel', { number: pageNumber })
                    : t('pdfToolbar.pageLabel', { number: pageNumber });
                  return (
                    <PdfThumbnail
                      key={`${filePath}-thumbnail-${pageNumber}`}
                      pdfDocument={readyDocument.pdfDocument}
                      pageNumber={pageNumber}
                      rotation={rotation}
                      active={currentPage === pageNumber}
                      navigationRootRef={navigationRef}
                      label={thumbnailLabel}
                      onSelect={jumpToPage}
                    />
                  );
                })
                : null}
            </div>
          </aside>
        ) : null}
        <div ref={viewerRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-900">
          {!readyDocument ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
            </div>
          ) : (
            <div className="px-4 py-2">
              {Array.from({ length: readyDocument.pdfDocument.numPages }, (_, index) => (
                <PdfPage
                  key={`${filePath}-${index + 1}`}
                  pdfDocument={readyDocument.pdfDocument}
                  pageNumber={index + 1}
                  scale={activeScale}
                  rotation={rotation}
                  basePageSize={readyDocument.firstPageSize}
                  viewerRootRef={viewerRef}
                  forceRender={forcedRenderPageNumbers.has(index + 1)}
                  searchMatches={searchMatchesByPage.get(index + 1) || []}
                  selectedSearchMatchId={selectedSearchMatchId}
                  onPageText={handlePageText}
                  onPageVisibilityChange={handlePageVisibilityChange}
                />
              ))}
            </div>
          )}

          {loadingOverlay ? (
            <div className="absolute left-3 top-3 z-10 rounded-md border border-neutral-200 bg-white/95 px-3 py-1.5 text-[12px] text-neutral-600 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95 dark:text-neutral-300">
              {loadingOverlay}
            </div>
          ) : null}

          {selectionAction ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleAddReference}
              className="absolute z-20 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-900 shadow-lg transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
              style={{ top: selectionAction.top, left: selectionAction.left }}
            >
              {t('selection.chatInPilotDeck')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
