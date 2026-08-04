import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { useTranslation } from 'react-i18next';
import {
  createImageRegionContentReference,
  createTextContentReference,
  type ContentReference,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from '../../../../types/contentReference';
import { useDomFileSearch } from '../../hooks/useDomFileSearch';
import { useFileSearchShortcut } from '../../hooks/useFileSearchShortcut';
import BuiltinOfficeToolbar from './BuiltinOfficeToolbar';
import RegionSelectionOverlay, { type CapturedRegion } from './RegionSelectionOverlay';
import { floatingSelectionSingleActionClassName } from './floatingSelectionAction';

type DocxBuiltinPreviewProps = {
  blob: Blob;
  projectName?: string;
  fileName: string;
  filePath: string;
  downloadUrl?: string | null;
  downloadName?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  onError: (error: Error) => void;
};

type OutlineItem = {
  id: string;
  level: number;
  title: string;
  element: HTMLElement;
};

type TextSelectionAction = {
  top: number;
  left: number;
  reference: ContentReference;
};

function surroundingText(text: string, selectedText: string, radius = 300) {
  const index = text.indexOf(selectedText);
  if (index < 0) return text.slice(0, radius * 2);
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + selectedText.length + radius));
}

function getHeadingLevel(element: HTMLElement): number | null {
  const tagMatch = /^H([1-6])$/.exec(element.tagName);
  if (tagMatch) return Number(tagMatch[1]);
  const classMatch = String(element.className).match(/heading[\s_-]*([1-6])/i);
  return classMatch ? Number(classMatch[1]) : null;
}

function findOutlineItems(root: HTMLElement): OutlineItem[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p'))
    .map((element, index) => {
      const level = getHeadingLevel(element);
      const title = element.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (!level || !title) return null;
      const id = `pilotdeck-docx-heading-${index}`;
      element.dataset.pilotdeckOutlineId = id;
      return { id, level, title, element };
    })
    .filter((item): item is OutlineItem => item !== null);
}

export default function DocxBuiltinPreview({
  blob,
  projectName,
  fileName,
  filePath,
  downloadUrl,
  downloadName,
  isFullscreen = false,
  onToggleFullscreen,
  refreshing = false,
  onRefresh,
  onError,
}: DocxBuiltinPreviewProps) {
  const { t } = useTranslation('codeEditor');
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onErrorRef = useRef(onError);
  const [rendered, setRendered] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [selectionAction, setSelectionAction] = useState<TextSelectionAction | null>(null);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const {
    matchCount: searchMatchCount,
    highlightStyles,
  } = useDomFileSearch({
    rootRef: viewerRef,
    query: searchQuery,
    activeIndex: searchMatchIndex,
    onActiveIndexChange: setSearchMatchIndex,
    enabled: rendered,
    contentKey: rendered,
  });
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useFileSearchShortcut({
    containerRef: surfaceRef,
    enabled: rendered,
    onOpen: openSearch,
  });

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const container = viewerRef.current;
    if (!container) return undefined;
    let cancelled = false;

    container.replaceChildren();
    setRendered(false);
    setOutline([]);

    renderAsync(blob, container, container, {
      className: 'pilotdeck-docx',
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderAltChunks: false,
      useBase64URL: true,
    })
      .then(() => {
        if (cancelled) return;
        setOutline(findOutlineItems(container));
        setRendered(true);
      })
      .catch((error) => {
        if (!cancelled) {
          onErrorRef.current(error instanceof Error ? error : new Error(String(error)));
        }
      });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [blob]);

  useEffect(() => {
    const wrapper = viewerRef.current?.querySelector<HTMLElement>('.pilotdeck-docx-wrapper');
    if (wrapper) wrapper.style.zoom = String(zoom);
  }, [rendered, zoom]);

  const moveSearch = useCallback((direction: -1 | 1) => {
    if (searchMatchCount === 0) return;
    setSearchMatchIndex((current) => (
      (current + direction + searchMatchCount) % searchMatchCount
    ));
  }, [searchMatchCount]);

  const updateSelectionAction = useCallback(() => {
    if (referenceMode === 'region') return;
    const root = viewerRef.current;
    const scroll = scrollRef.current;
    const selection = window.getSelection();
    if (!root || !scroll || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setSelectionAction(null);
      return;
    }
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      setSelectionAction(null);
      return;
    }
    const rangeRect = range.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const section = (range.startContainer.parentElement || range.startContainer)
      && (range.startContainer.parentElement?.closest<HTMLElement>('section.pilotdeck-docx') || null);
    const sectionRect = section?.getBoundingClientRect();
    const heading = [...outline]
      .reverse()
      .find((item) => (
        item.element === range.startContainer
        || Boolean(item.element.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING)
      ));
    const documentText = root.textContent?.replace(/\s+/g, ' ').trim() || selectedText;
    const prefixIndex = documentText.indexOf(selectedText);
    const reference = createTextContentReference({
      selectionMode: 'text',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        revision: { size: blob.size },
      },
      renderer: { id: 'docx', backend: 'builtin', locatorQuality: 'semantic' },
      locator: {
        surface: 'document',
        ...(heading ? { headingPath: [heading.title] } : {}),
        quote: {
          exact: selectedText,
          ...(prefixIndex >= 0 ? {
            prefix: documentText.slice(Math.max(0, prefixIndex - 80), prefixIndex),
            suffix: documentText.slice(prefixIndex + selectedText.length, prefixIndex + selectedText.length + 80),
          } : {}),
        },
        ...(sectionRect ? {
          rects: [{
            x: (rangeRect.left - sectionRect.left) / Math.max(1, sectionRect.width),
            y: (rangeRect.top - sectionRect.top) / Math.max(1, sectionRect.height),
            width: rangeRect.width / Math.max(1, sectionRect.width),
            height: rangeRect.height / Math.max(1, sectionRect.height),
          }],
        } : {}),
      },
      selectedText,
      surroundingText: surroundingText(documentText, selectedText),
    });
    setSelectionAction({
      left: Math.max(12, Math.min(scroll.clientWidth - 180, rangeRect.left - scrollRect.left + scroll.scrollLeft + rangeRect.width / 2 - 70)),
      top: Math.max(12, rangeRect.top - scrollRect.top + scroll.scrollTop - 42),
      reference,
    });
  }, [blob.size, fileName, filePath, outline, projectName, referenceMode]);

  useEffect(() => {
    const schedule = () => {
      if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = window.setTimeout(updateSelectionAction, 40);
    };
    const clear = () => setSelectionAction(null);
    document.addEventListener('selectionchange', clear);
    document.addEventListener('mouseup', schedule);
    document.addEventListener('touchend', schedule);
    document.addEventListener('keyup', schedule);
    return () => {
      if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
      document.removeEventListener('selectionchange', clear);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('touchend', schedule);
      document.removeEventListener('keyup', schedule);
    };
  }, [updateSelectionAction]);

  const capabilities: ReferenceCapabilities = {
    text: rendered ? { state: 'available' } : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    cells: { state: 'unavailable', reason: 'NO_CELL_MODEL' },
    region: rendered ? { state: 'available' } : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    recommendedMode: 'text',
  };

  const handleRegionCommit = (capture: CapturedRegion) => {
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        revision: { size: blob.size },
      },
      renderer: { id: 'docx', backend: 'builtin', locatorQuality: 'visual' },
      locator: { surface: 'document', rect: capture.rect },
      image: {
        name: `reference-${fileName}-region-${Date.now()}.png`,
        mimeType: 'image/png',
        width: capture.width,
        height: capture.height,
        dataUrl: capture.dataUrl,
      },
      nearbyText: capture.nearbyText,
    });
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', { detail: reference }));
    setReferenceMode(null);
  };

  const outlinePanel = useMemo(() => (
    <aside className="w-64 shrink-0 overflow-auto border-r border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {t('pdfToolbar.outline')}
      </div>
      <div className="space-y-0.5">
        {outline.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            className="block min-h-8 w-full rounded-md py-1.5 pr-2 text-left text-[12px] leading-5 text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
            onClick={() => item.element.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          >
            <span className="line-clamp-2">{item.title}</span>
          </button>
        ))}
      </div>
    </aside>
  ), [outline, t]);

  return (
    <div
      ref={surfaceRef}
      data-file-search-surface
      className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900"
    >
      <style>{`
        ${highlightStyles}
        .pilotdeck-docx-wrapper {
          background: rgb(245 245 245) !important;
          padding: 28px !important;
        }
        .dark .pilotdeck-docx-wrapper {
          background: rgb(23 23 23) !important;
        }
        .pilotdeck-docx-wrapper > section.pilotdeck-docx {
          margin: 0 auto 24px !important;
          box-shadow: 0 1px 4px rgb(0 0 0 / 0.16) !important;
        }
      `}</style>
      {/* docx-preview sections reflect stored break markers, not reliable Word pagination. */}
      <BuiltinOfficeToolbar
        navigationAvailable={outline.length > 0}
        navigationVisible={navigationVisible && outline.length > 0}
        onToggleNavigation={() => setNavigationVisible((value) => !value)}
        zoom={zoom}
        onZoomChange={setZoom}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        searchMatchIndex={searchMatchIndex}
        searchMatchCount={searchMatchCount}
        onPreviousMatch={() => moveSearch(-1)}
        onNextMatch={() => moveSearch(1)}
        refreshing={refreshing}
        onRefresh={onRefresh}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        referenceCapabilities={capabilities}
        referenceMode={referenceMode}
        onSelectReferenceMode={(mode) => {
          if (mode === 'region') {
            window.getSelection()?.removeAllRanges();
            setSelectionAction(null);
            setReferenceMode('region');
          } else {
            setReferenceMode(null);
          }
        }}
        onCancelReferenceMode={() => setReferenceMode(null)}
      />
      <div className="flex min-h-0 flex-1">
        {navigationVisible && outline.length > 0 ? outlinePanel : null}
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
          <div ref={viewerRef} data-testid="docx-builtin-preview" className="min-h-full" />
          {selectionAction ? (
            <button
              type="button"
              className={`absolute z-20 ${floatingSelectionSingleActionClassName}`}
              style={{ top: selectionAction.top, left: selectionAction.left }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', {
                  detail: selectionAction.reference,
                }));
                window.getSelection()?.removeAllRanges();
                setSelectionAction(null);
              }}
            >
              {t('selection.chatInPilotDeck')}
            </button>
          ) : null}
          <RegionSelectionOverlay
            active={referenceMode === 'region'}
            hostRef={scrollRef}
            resolveTarget={(element) => {
              const section = element?.closest<HTMLElement>('section.pilotdeck-docx');
              if (!section || !viewerRef.current?.contains(section)) return null;
              return {
                element: section,
                surface: 'document',
                nearbyText: section.textContent?.replace(/\s+/g, ' ').trim(),
              };
            }}
            onCommit={handleRegionCommit}
            onCancel={() => setReferenceMode(null)}
          />
        </div>
      </div>
    </div>
  );
}
