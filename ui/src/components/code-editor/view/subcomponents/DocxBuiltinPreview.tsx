import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { useTranslation } from 'react-i18next';
import {
  createImageRegionContentReference,
  createTextContentReference,
  type ContentReference,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from '../../../../types/contentReference';
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

type SearchMatch = {
  range: Range;
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

function findTextMatches(root: HTMLElement, query: string): SearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const matches: SearchMatch[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('style,script')) return NodeFilter.FILTER_REJECT;
      return node.textContent?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const text = node.textContent || '';
    const normalizedText = text.toLocaleLowerCase();
    let start = 0;
    while (start <= normalizedText.length - normalizedQuery.length) {
      const index = normalizedText.indexOf(normalizedQuery, start);
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + normalizedQuery.length);
      matches.push({
        range,
        element: node.parentElement || root,
      });
      start = index + Math.max(1, normalizedQuery.length);
    }
    node = walker.nextNode();
  }

  return matches;
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
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onErrorRef = useRef(onError);
  const [rendered, setRendered] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pages, setPages] = useState<HTMLElement[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [selectionAction, setSelectionAction] = useState<TextSelectionAction | null>(null);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const searchMatchesRef = useRef<SearchMatch[]>([]);
  const highlightId = useId().replace(/[^a-z0-9_-]/gi, '');
  const allHighlightName = `pilotdeck-docx-search-${highlightId}`;
  const activeHighlightName = `${allHighlightName}-active`;

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
    setPages([]);
    setCurrentPage(1);

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
        const nextPages = Array.from(
          container.querySelectorAll<HTMLElement>('section.pilotdeck-docx'),
        );
        setPages(nextPages);
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

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || pages.length === 0) return undefined;
    const updateCurrentPage = () => {
      const top = scroll.getBoundingClientRect().top + 24;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      pages.forEach((page, index) => {
        const distance = Math.abs(page.getBoundingClientRect().top - top);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      setCurrentPage(closestIndex + 1);
    };
    updateCurrentPage();
    scroll.addEventListener('scroll', updateCurrentPage, { passive: true });
    return () => scroll.removeEventListener('scroll', updateCurrentPage);
  }, [pages]);

  useEffect(() => {
    const root = viewerRef.current;
    const cssHighlights = (globalThis.CSS as unknown as {
      highlights?: Map<string, unknown>;
    })?.highlights;
    const HighlightConstructor = (globalThis as unknown as {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    cssHighlights?.delete(allHighlightName);
    cssHighlights?.delete(activeHighlightName);
    searchMatchesRef.current = [];

    if (!root || !searchQuery.trim()) {
      setSearchMatchIndex(0);
      return;
    }

    const matches = findTextMatches(root, searchQuery);
    searchMatchesRef.current = matches;
    setSearchMatchIndex((current) => (
      matches.length > 0 ? Math.min(current, matches.length - 1) : 0
    ));
    if (cssHighlights && HighlightConstructor && matches.length > 0) {
      cssHighlights.set(
        allHighlightName,
        new HighlightConstructor(...matches.map((match) => match.range)),
      );
    }

    return () => {
      cssHighlights?.delete(allHighlightName);
      cssHighlights?.delete(activeHighlightName);
    };
  }, [activeHighlightName, allHighlightName, rendered, searchQuery]);

  useEffect(() => {
    const matches = searchMatchesRef.current;
    const cssHighlights = (globalThis.CSS as unknown as {
      highlights?: Map<string, unknown>;
    })?.highlights;
    const HighlightConstructor = (globalThis as unknown as {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    cssHighlights?.delete(activeHighlightName);
    if (matches.length === 0) return;
    const match = matches[Math.min(searchMatchIndex, matches.length - 1)];
    if (cssHighlights && HighlightConstructor) {
      cssHighlights.set(activeHighlightName, new HighlightConstructor(match.range));
    }
    match.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeHighlightName, searchMatchIndex, searchQuery]);

  const goToPage = useCallback((pageNumber: number) => {
    const page = pages[Math.max(0, Math.min(pages.length - 1, pageNumber - 1))];
    page?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [pages]);

  const moveSearch = useCallback((direction: -1 | 1) => {
    const count = searchMatchesRef.current.length;
    if (count === 0) return;
    setSearchMatchIndex((current) => (current + direction + count) % count);
  }, []);

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
    const page = (range.startContainer.parentElement || range.startContainer)
      && (range.startContainer.parentElement?.closest<HTMLElement>('section.pilotdeck-docx') || null);
    const pageIndex = page ? pages.indexOf(page) : -1;
    const pageRect = page?.getBoundingClientRect();
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
        ...(pageIndex >= 0 ? { pageNumbers: [pageIndex + 1] } : {}),
        ...(heading ? { headingPath: [heading.title] } : {}),
        quote: {
          exact: selectedText,
          ...(prefixIndex >= 0 ? {
            prefix: documentText.slice(Math.max(0, prefixIndex - 80), prefixIndex),
            suffix: documentText.slice(prefixIndex + selectedText.length, prefixIndex + selectedText.length + 80),
          } : {}),
        },
        ...(pageRect ? {
          rects: [{
            x: (rangeRect.left - pageRect.left) / Math.max(1, pageRect.width),
            y: (rangeRect.top - pageRect.top) / Math.max(1, pageRect.height),
            width: rangeRect.width / Math.max(1, pageRect.width),
            height: rangeRect.height / Math.max(1, pageRect.height),
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
  }, [blob.size, fileName, filePath, outline, pages, projectName, referenceMode]);

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
    const pageNumber = capture.pageNumber || currentPage;
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        revision: { size: blob.size },
      },
      renderer: { id: 'docx', backend: 'builtin', locatorQuality: 'visual' },
      locator: { surface: 'page', pageNumber, rect: capture.rect },
      image: {
        name: `reference-${fileName}-page-${pageNumber}-${Date.now()}.png`,
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
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      <style>{`
        ::highlight(${allHighlightName}) {
          background: rgba(250, 204, 21, 0.62);
          color: inherit;
        }
        ::highlight(${activeHighlightName}) {
          background: rgba(249, 115, 22, 0.88);
          color: #111827;
        }
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
      <BuiltinOfficeToolbar
        navigationAvailable={outline.length > 0}
        navigationVisible={navigationVisible && outline.length > 0}
        onToggleNavigation={() => setNavigationVisible((value) => !value)}
        zoom={zoom}
        onZoomChange={setZoom}
        currentItem={currentPage}
        itemCount={pages.length}
        onPreviousItem={() => goToPage(currentPage - 1)}
        onNextItem={() => goToPage(currentPage + 1)}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchMatchIndex={searchMatchIndex}
        searchMatchCount={searchMatchesRef.current.length}
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
              const page = element?.closest<HTMLElement>('section.pilotdeck-docx');
              if (!page || !viewerRef.current?.contains(page)) return null;
              const pageIndex = pages.indexOf(page);
              return {
                element: page,
                surface: 'page',
                pageNumber: pageIndex >= 0 ? pageIndex + 1 : currentPage,
                nearbyText: page.textContent?.replace(/\s+/g, ' ').trim(),
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
