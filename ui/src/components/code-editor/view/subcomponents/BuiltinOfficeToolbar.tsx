import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Minimize,
  PanelLeft,
  RefreshCw,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  ContentReferenceSelectionMode,
  ReferenceCapabilities,
} from '../../../../types/contentReference';
import ContentReferenceMenu from './ContentReferenceMenu';
import FloatingFileSearchControls from './FloatingFileSearchControls';

type BuiltinOfficeToolbarProps = {
  navigationVisible?: boolean;
  navigationAvailable?: boolean;
  onToggleNavigation?: () => void;
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  onZoomChange: (zoom: number) => void;
  currentItem?: number;
  itemCount?: number;
  onPreviousItem?: () => void;
  onNextItem?: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchMatchIndex: number;
  searchMatchCount: number;
  onPreviousMatch: () => void;
  onNextMatch: () => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | null;
  downloadUrl?: string | null;
  downloadName?: string;
  referenceCapabilities?: ReferenceCapabilities;
  referenceMode?: ContentReferenceSelectionMode | null;
  onSelectReferenceMode?: (mode: ContentReferenceSelectionMode) => void;
  onCancelReferenceMode?: () => void;
};

const buttonClass = [
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-600 transition-colors',
  'hover:bg-neutral-100 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-40',
  'dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50',
].join(' ');

function Separator() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />;
}

export default function BuiltinOfficeToolbar({
  navigationVisible = false,
  navigationAvailable = false,
  onToggleNavigation,
  zoom,
  minZoom = 0.5,
  maxZoom = 2,
  onZoomChange,
  currentItem,
  itemCount,
  onPreviousItem,
  onNextItem,
  searchQuery,
  onSearchQueryChange,
  searchOpen,
  onSearchOpenChange,
  searchMatchIndex,
  searchMatchCount,
  onPreviousMatch,
  onNextMatch,
  refreshing = false,
  onRefresh,
  isFullscreen = false,
  onToggleFullscreen,
  downloadUrl,
  downloadName,
  referenceCapabilities,
  referenceMode = null,
  onSelectReferenceMode,
  onCancelReferenceMode,
}: BuiltinOfficeToolbarProps) {
  const { t } = useTranslation('codeEditor');
  const hasItemControls = Boolean(itemCount && itemCount > 0);

  return (
    <div className="relative z-20 min-w-0 shrink-0">
      <div className="flex min-h-12 w-full min-w-0 items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-950">
      {navigationAvailable && onToggleNavigation ? (
        <>
          <button
            type="button"
            className={`${buttonClass} ${navigationVisible ? 'bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-50' : ''}`}
            title={navigationVisible ? t('pdfToolbar.hideNavigation') : t('pdfToolbar.showNavigation')}
            aria-label={navigationVisible ? t('pdfToolbar.hideNavigation') : t('pdfToolbar.showNavigation')}
            onClick={onToggleNavigation}
          >
            <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <Separator />
        </>
      ) : null}

      <button
        type="button"
        className={buttonClass}
        title={t('pdfToolbar.zoomOut')}
        aria-label={t('pdfToolbar.zoomOut')}
        disabled={zoom <= minZoom}
        onClick={() => onZoomChange(Math.max(minZoom, Math.round((zoom - 0.1) * 10) / 10))}
      >
        <ZoomOut className="h-4 w-4" strokeWidth={1.75} />
      </button>
      <span className="flex h-8 min-w-16 items-center justify-center rounded-md border border-neutral-200 px-2 text-[12px] tabular-nums text-neutral-700 dark:border-neutral-800 dark:text-neutral-200">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        className={buttonClass}
        title={t('pdfToolbar.zoomIn')}
        aria-label={t('pdfToolbar.zoomIn')}
        disabled={zoom >= maxZoom}
        onClick={() => onZoomChange(Math.min(maxZoom, Math.round((zoom + 0.1) * 10) / 10))}
      >
        <ZoomIn className="h-4 w-4" strokeWidth={1.75} />
      </button>

      {hasItemControls ? (
        <>
          <Separator />
          <button
            type="button"
            className={buttonClass}
            title={t('builtinOfficePreview.previousItem')}
            aria-label={t('builtinOfficePreview.previousItem')}
            disabled={!currentItem || currentItem <= 1}
            onClick={onPreviousItem}
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <span className="min-w-14 text-center text-[12px] tabular-nums text-neutral-600 dark:text-neutral-300">
            {currentItem || 1} / {itemCount}
          </span>
          <button
            type="button"
            className={buttonClass}
            title={t('builtinOfficePreview.nextItem')}
            aria-label={t('builtinOfficePreview.nextItem')}
            disabled={!currentItem || currentItem >= (itemCount || 0)}
            onClick={onNextItem}
          >
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </>
      ) : null}

      <Separator />
      <button
        type="button"
        className={`${buttonClass} ${searchOpen ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' : ''}`}
        title={t('builtinOfficePreview.search')}
        aria-label={t('builtinOfficePreview.search')}
        onClick={() => {
          if (searchOpen) {
            onSearchOpenChange(false);
            onSearchQueryChange('');
          } else {
            onSearchOpenChange(true);
          }
        }}
      >
        <Search className="h-4 w-4" strokeWidth={1.75} />
      </button>
      <span className="flex-1" />
      {referenceCapabilities && onSelectReferenceMode ? (
        <ContentReferenceMenu
          capabilities={referenceCapabilities}
          activeMode={referenceMode}
          onSelectMode={onSelectReferenceMode}
          onCancelMode={onCancelReferenceMode}
          compact
        />
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          className={buttonClass}
          title={t('officePreview.refresh')}
          aria-label={t('officePreview.refresh')}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.75} />
        </button>
      ) : null}
      {onToggleFullscreen ? (
        <button
          type="button"
          className={buttonClass}
          title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
          aria-label={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
          onClick={onToggleFullscreen}
        >
          {isFullscreen
            ? <Minimize className="h-4 w-4" strokeWidth={1.75} />
            : <Maximize2 className="h-4 w-4" strokeWidth={1.75} />}
        </button>
      ) : null}
      {downloadUrl ? (
        <a
          className={buttonClass}
          href={downloadUrl}
          download={downloadName}
          title={t('actions.download')}
          aria-label={t('actions.download')}
        >
          <Download className="h-4 w-4" strokeWidth={1.75} />
        </a>
      ) : null}
      </div>
      {searchOpen ? (
        <FloatingFileSearchControls
          query={searchQuery}
          onQueryChange={onSearchQueryChange}
          matchIndex={searchMatchIndex}
          matchCount={searchMatchCount}
          onPrevious={onPreviousMatch}
          onNext={onNextMatch}
          onClose={() => {
            onSearchOpenChange(false);
            onSearchQueryChange('');
          }}
          searchLabel={t('builtinOfficePreview.search')}
          placeholder={t('builtinOfficePreview.searchPlaceholder')}
          previousLabel={t('pdfToolbar.previousResult')}
          nextLabel={t('pdfToolbar.nextResult')}
          closeLabel={t('builtinOfficePreview.closeSearch')}
          noMatchesLabel={t('builtinOfficePreview.noMatches')}
        />
      ) : null}
    </div>
  );
}
