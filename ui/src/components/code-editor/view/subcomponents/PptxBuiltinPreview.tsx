import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PptxViewer,
  RECOMMENDED_ZIP_LIMITS,
  type SearchHighlightHandle,
  type SlideHandle,
  type TextSearchResult,
} from '@aiden0z/pptx-renderer';
import { useTranslation } from 'react-i18next';
import {
  createImageRegionContentReference,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from '../../../../types/contentReference';
import BuiltinOfficeToolbar from './BuiltinOfficeToolbar';
import RegionSelectionOverlay, { type CapturedRegion } from './RegionSelectionOverlay';

type PptxBuiltinPreviewProps = {
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

function PptxThumbnail({
  viewer,
  index,
  active,
  onSelect,
}: {
  viewer: PptxViewer;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SlideHandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    handleRef.current?.dispose();
    container.replaceChildren();
    const handle = viewer.renderThumbnailToContainer(index, container, { width: 144 });
    handleRef.current = handle;
    return () => {
      handleRef.current?.dispose();
      handleRef.current = null;
      container.replaceChildren();
    };
  }, [index, viewer]);

  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      className={[
        'flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors',
        active
          ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40'
          : 'border-transparent hover:border-neutral-300 hover:bg-neutral-100 dark:hover:border-neutral-700 dark:hover:bg-neutral-900',
      ].join(' ')}
      onClick={onSelect}
    >
      <span className="w-5 shrink-0 pt-1 text-center text-[11px] tabular-nums text-neutral-500">
        {index + 1}
      </span>
      <span
        ref={containerRef}
        className="block min-h-[76px] min-w-0 flex-1 overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-neutral-200 dark:ring-neutral-700"
      />
    </button>
  );
}

export default function PptxBuiltinPreview({
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
}: PptxBuiltinPreviewProps) {
  const { t } = useTranslation('codeEditor');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PptxViewer | null>(null);
  const highlightHandlesRef = useRef<SearchHighlightHandle[]>([]);
  const [viewer, setViewer] = useState<PptxViewer | null>(null);
  const [loading, setLoading] = useState(true);
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<TextSearchResult[]>([]);
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);

  const clearHighlights = useCallback(() => {
    highlightHandlesRef.current.forEach((handle) => handle.dispose());
    highlightHandlesRef.current = [];
    viewerRef.current?.clearSearchHighlights();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setViewer(null);
    setSlideCount(0);
    setCurrentSlide(0);
    container.replaceChildren();

    PptxViewer.open(blob, container, {
      renderMode: 'slide',
      fitMode: 'contain',
      zoomPercent: 100,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
      signal: controller.signal,
      onSlideChange: (index) => {
        if (!cancelled) setCurrentSlide(index);
      },
      onSlideError: (_index, error) => {
        if (!cancelled) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      },
    })
      .then((nextViewer) => {
        if (cancelled) {
          nextViewer.destroy();
          return;
        }
        viewerRef.current = nextViewer;
        setViewer(nextViewer);
        setSlideCount(nextViewer.slideCount);
        setCurrentSlide(nextViewer.currentSlideIndex);
      })
      .catch((error) => {
        if (!cancelled && !controller.signal.aborted) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      clearHighlights();
      viewerRef.current?.destroy();
      viewerRef.current = null;
      container.replaceChildren();
    };
  }, [blob, clearHighlights, onError]);

  useEffect(() => {
    if (!viewer) return;
    void viewer.setZoom(Math.round(zoom * 100));
  }, [viewer, zoom]);

  useEffect(() => {
    clearHighlights();
    if (!viewer || !searchQuery.trim()) {
      setSearchMatches([]);
      setSearchMatchIndex(0);
      return;
    }
    const matches = viewer.searchText(searchQuery);
    setSearchMatches(matches);
    setSearchMatchIndex((current) => (
      matches.length > 0 ? Math.min(current, matches.length - 1) : 0
    ));
  }, [clearHighlights, searchQuery, viewer]);

  useEffect(() => {
    if (!viewer || searchMatches.length === 0) return undefined;
    let cancelled = false;
    const selectedIndex = Math.min(searchMatchIndex, searchMatches.length - 1);
    const selected = searchMatches[selectedIndex];

    const renderHighlights = async () => {
      await viewer.goToSlide(selected.slideIndex);
      if (cancelled) return;
      clearHighlights();
      const matchesOnSlide = searchMatches.filter(
        (match) => match.slideIndex === selected.slideIndex,
      );
      const handles = await Promise.all(matchesOnSlide.map((match) => (
        viewer.highlightSearchResult(match, match === selected
          ? {
            scrollIntoView: false,
            borderColor: '#f97316',
            backgroundColor: 'rgba(249, 115, 22, 0.28)',
            borderWidth: 3,
            boxShadow: '0 0 0 2px rgba(255,255,255,0.85)',
            padding: 2,
          }
          : {
            scrollIntoView: false,
            borderColor: '#eab308',
            backgroundColor: 'rgba(250, 204, 21, 0.22)',
            borderWidth: 2,
            padding: 1,
          })
      )));
      if (cancelled) {
        handles.forEach((handle) => handle?.dispose());
        return;
      }
      highlightHandlesRef.current = handles.filter(
        (handle): handle is SearchHighlightHandle => handle !== null,
      );
    };
    void renderHighlights();
    return () => {
      cancelled = true;
    };
  }, [clearHighlights, searchMatchIndex, searchMatches, viewer]);

  const goToSlide = useCallback((index: number) => {
    if (!viewer) return;
    const nextIndex = Math.max(0, Math.min(viewer.slideCount - 1, index));
    clearHighlights();
    void viewer.goToSlide(nextIndex);
  }, [clearHighlights, viewer]);

  const moveSearch = useCallback((direction: -1 | 1) => {
    if (searchMatches.length === 0) return;
    setSearchMatchIndex((current) => (
      (current + direction + searchMatches.length) % searchMatches.length
    ));
  }, [searchMatches.length]);

  const capabilities: ReferenceCapabilities = {
    text: { state: 'unavailable', reason: 'NO_TEXT_LAYER' },
    cells: { state: 'unavailable', reason: 'NO_CELL_MODEL' },
    region: viewer
      ? { state: 'available' }
      : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    recommendedMode: 'region',
  };

  const handleRegionCommit = (capture: CapturedRegion) => {
    const slideNumber = capture.slideNumber || currentSlide + 1;
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        revision: { size: blob.size },
      },
      renderer: { id: 'pptx', backend: 'builtin', locatorQuality: 'visual' },
      locator: { surface: 'slide', slideNumber, rect: capture.rect },
      image: {
        name: `reference-${fileName}-slide-${slideNumber}-${Date.now()}.png`,
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      <BuiltinOfficeToolbar
        navigationAvailable={slideCount > 0}
        navigationVisible={navigationVisible}
        onToggleNavigation={() => setNavigationVisible((value) => !value)}
        zoom={zoom}
        minZoom={0.5}
        maxZoom={3}
        onZoomChange={setZoom}
        currentItem={currentSlide + 1}
        itemCount={slideCount}
        onPreviousItem={() => goToSlide(currentSlide - 1)}
        onNextItem={() => goToSlide(currentSlide + 1)}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchMatchIndex={searchMatchIndex}
        searchMatchCount={searchMatches.length}
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
        onSelectReferenceMode={(mode) => setReferenceMode(mode === 'region' ? mode : null)}
        onCancelReferenceMode={() => setReferenceMode(null)}
      />
      <div className="flex min-h-0 flex-1">
        {navigationVisible && viewer && slideCount > 0 ? (
          <aside className="w-52 shrink-0 overflow-auto border-r border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950">
            <div className="space-y-1">
              {Array.from({ length: slideCount }, (_, index) => (
                <PptxThumbnail
                  key={index}
                  viewer={viewer}
                  index={index}
                  active={index === currentSlide}
                  onSelect={() => goToSlide(index)}
                />
              ))}
            </div>
          </aside>
        ) : null}
        <div className="relative min-h-0 flex-1 overflow-hidden p-5">
          <div
            ref={containerRef}
            data-testid="pptx-builtin-preview"
            className="h-full w-full overflow-hidden"
          />
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-100/90 text-sm text-neutral-500 backdrop-blur-[1px] dark:bg-neutral-900/90 dark:text-neutral-400">
              {t('builtinOfficePreview.loadingPresentation')}
            </div>
          ) : null}
          <RegionSelectionOverlay
            active={referenceMode === 'region'}
            hostRef={containerRef}
            resolveTarget={() => {
              const element = containerRef.current;
              if (!element) return null;
              return {
                element,
                surface: 'slide',
                slideNumber: currentSlide + 1,
                nearbyText: searchMatches
                  .filter((match) => match.slideIndex === currentSlide)
                  .map((match) => match.text)
                  .join(' '),
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
