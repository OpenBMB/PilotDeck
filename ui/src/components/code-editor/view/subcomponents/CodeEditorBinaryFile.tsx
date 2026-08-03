import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { IWorkbookData } from '@univerjs/core';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../utils/api';
import {
  readOfficePreviewStatus,
  type OfficePreviewService,
  type OfficePreviewStatus,
} from '../../../../utils/officePreviewStatus';
import type { CodeEditorFile } from '../../types/types';
import {
  isBuiltinOfficeFile,
  isImageFile,
  isOfficeFile,
  isPdfFile,
  isSpreadsheetFile,
  isWordFile,
} from '../../utils/binaryFile';
import { getPdfNavigationMode } from '../../utils/documentPreview';
import {
  createImageRegionContentReference,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from '../../../../types/contentReference';
import ContentReferenceMenu from './ContentReferenceMenu';
import PdfDocumentPreview from './PdfDocumentPreview';
import RegionSelectionOverlay, { type CapturedRegion } from './RegionSelectionOverlay';
import SpreadsheetTabs, { type SpreadsheetSheetTab } from './SpreadsheetTabs';

const SpreadsheetInteractivePreview = lazy(
  () => import('./SpreadsheetInteractivePreview'),
);
const DocxBuiltinPreview = lazy(
  () => import('./DocxBuiltinPreview'),
);
const PptxBuiltinPreview = lazy(
  () => import('./PptxBuiltinPreview'),
);

type CodeEditorBinaryFileProps = {
  file: CodeEditorFile;
  projectName?: string;
  isSidebar: boolean;
  compactHeader?: boolean;
  isFullscreen: boolean;
  isExpanded?: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  onToggleExpand?: (() => void) | null;
  title: string;
  message: string;
  headerPrefix?: ReactNode;
};

type BlobSource = 'raw' | 'office-pdf';
type ReloadOptions = { force?: boolean };

type SpreadsheetPreviewManifest = {
  version: number;
  revision: string;
  activeSheetIndex: number;
  sheets: SpreadsheetSheetTab[];
};

type SpreadsheetPreviewWarning = {
  code: string;
  message: string;
};

type SpreadsheetInteractivePreviewData = SpreadsheetPreviewManifest & {
  warnings: SpreadsheetPreviewWarning[];
  workbook: IWorkbookData;
};

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function getFileTypeBadge(filename: string) {
  const extension = getExtension(filename);
  if (['doc', 'docx', 'wps', 'odt'].includes(extension)) {
    return {
      label: 'W',
      className: 'bg-blue-600 text-white',
      titleKey: 'fileTypes.word',
    };
  }
  if (['xls', 'xlsx', 'et', 'ods'].includes(extension)) {
    return {
      label: 'X',
      className: 'bg-emerald-600 text-white',
      titleKey: 'fileTypes.excel',
    };
  }
  if (['ppt', 'pptx', 'dps', 'odp'].includes(extension)) {
    return {
      label: 'P',
      className: 'bg-orange-600 text-white',
      titleKey: 'fileTypes.powerpoint',
    };
  }
  if (extension === 'pdf') {
    return {
      label: 'PDF',
      className: 'bg-red-600 text-white text-[7px]',
      titleKey: 'fileTypes.pdf',
    };
  }
  if (isImageFile(filename)) {
    return {
      label: 'IMG',
      className: 'bg-violet-600 text-white text-[7px]',
      titleKey: 'fileTypes.image',
    };
  }
  return {
    label: 'F',
    className: 'bg-neutral-500 text-white',
    titleKey: 'fileTypes.file',
  };
}

function FileTypeBadge({ fileName }: { fileName: string }) {
  const { t } = useTranslation('codeEditor');
  const badge = getFileTypeBadge(fileName);

  return (
    <span
      title={t(badge.titleKey)}
      aria-label={t(badge.titleKey)}
      className={[
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold leading-none shadow-sm ring-1 ring-black/5',
        badge.className,
      ].join(' ')}
    >
      {badge.label}
    </span>
  );
}

async function readPreviewErrorResponse(res: Response) {
  let detail = '';
  let code = '';
  try {
    const body = await res.json();
    detail = body?.error || body?.code || '';
    code = body?.code || '';
  } catch {
    detail = await res.text().catch(() => '');
  }
  const error = new Error(detail || `HTTP ${res.status}`) as Error & { code?: string };
  error.code = code;
  return error;
}

function useFileBlob(
  projectName: string | undefined,
  filePath: string,
  enabled: boolean,
  source: BlobSource = 'raw',
) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [reloadRequest, setReloadRequest] = useState({ key: 0, force: false });
  const lastRequestKeyRef = useRef('');

  const reload = useCallback((options: ReloadOptions = {}) => {
    setReloadRequest((value) => ({
      key: value.key + 1,
      force: Boolean(options.force),
    }));
  }, []);

  useEffect(() => {
    if (!enabled || !projectName) {
      setBlob(null);
      setLoading(false);
      setErrorMessage(enabled ? 'Project is not available.' : null);
      setErrorCode(null);
      return;
    }

    const requestKey = `${source}:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;

    let cancelled = false;

    if (isNewFile) {
      setBlob(null);
    }
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    const request = source === 'office-pdf'
      ? api.readOfficePdfPreviewBlob(projectName, filePath, { force: reloadRequest.force })
      : api.readFileBlob(projectName, filePath);

    request
      .then(async (res: Response) => {
        if (res.ok) {
          return res.blob();
        }

        throw await readPreviewErrorResponse(res);
      })
      .then((nextBlob: Blob) => {
        if (cancelled) return;
        setBlob(nextBlob);
      })
      .catch((error: Error & { code?: string }) => {
        if (cancelled) return;
        if (isNewFile) {
          setBlob(null);
        }
        setErrorMessage(error.message || 'Failed to load file preview.');
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, filePath, source, reloadRequest.force, reloadRequest.key]);

  return { blob, errorMessage, errorCode, loading, reload };
}

function useOfficePdfPreviewUrl(
  projectName: string | undefined,
  filePath: string,
  enabled: boolean,
) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [reloadRequest, setReloadRequest] = useState({ key: 0, force: false });
  const lastRequestKeyRef = useRef('');

  const reload = useCallback((options: ReloadOptions = {}) => {
    setReloadRequest((value) => ({
      key: value.key + 1,
      force: Boolean(options.force),
    }));
  }, []);

  useEffect(() => {
    if (!enabled || !projectName) {
      setPreviewUrl(null);
      setLoading(false);
      setErrorMessage(enabled ? 'Project is not available.' : null);
      setErrorCode(null);
      return undefined;
    }

    const requestKey = `office-pdf:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;
    const controller = new AbortController();

    if (isNewFile) {
      setPreviewUrl(null);
    }
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    const cacheKey = `${reloadRequest.key}`;
    const nextPreviewUrl = api.officePdfPreviewUrl(projectName, filePath, { cacheKey });

    api.preflightOfficePdfPreview(projectName, filePath, {
      force: reloadRequest.force,
      cacheKey,
      signal: controller.signal,
    })
      .then(async (res: Response) => {
        if (!res.ok) {
          throw await readPreviewErrorResponse(res);
        }
        await res.arrayBuffer().catch(() => null);
        if (!controller.signal.aborted) {
          setPreviewUrl(nextPreviewUrl);
        }
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        if (isNewFile) {
          setPreviewUrl(null);
        }
        setErrorMessage(error.message || 'Failed to load file preview.');
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [enabled, projectName, filePath, reloadRequest.force, reloadRequest.key]);

  return { previewUrl, errorMessage, errorCode, loading, reload };
}

function useSpreadsheetPreviewManifest(
  projectName: string | undefined,
  filePath: string,
  enabled: boolean,
) {
  const [manifest, setManifest] = useState<SpreadsheetPreviewManifest | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [reloadRequest, setReloadRequest] = useState({ key: 0, force: false });
  const lastRequestKeyRef = useRef('');

  const reload = useCallback((options: ReloadOptions = {}) => {
    setReloadRequest((value) => ({
      key: value.key + 1,
      force: Boolean(options.force),
    }));
  }, []);

  useEffect(() => {
    if (!enabled || !projectName) {
      setManifest(null);
      setLoading(false);
      setErrorMessage(enabled ? 'Project is not available.' : null);
      setErrorCode(null);
      return undefined;
    }

    const requestKey = `spreadsheet:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;
    const controller = new AbortController();

    if (isNewFile) setManifest(null);
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    api.spreadsheetPreviewManifest(projectName, filePath, {
      force: reloadRequest.force,
      cacheKey: reloadRequest.key,
      signal: controller.signal,
    })
      .then(async (res: Response) => {
        if (!res.ok) throw await readPreviewErrorResponse(res);
        return res.json();
      })
      .then((nextManifest: SpreadsheetPreviewManifest) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(nextManifest?.sheets) || nextManifest.sheets.length === 0) {
          throw new Error('The workbook does not contain a visible worksheet.');
        }
        setManifest(nextManifest);
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        if (isNewFile) setManifest(null);
        setErrorMessage(error.message || 'Failed to read workbook worksheets.');
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, filePath, projectName, reloadRequest.force, reloadRequest.key]);

  return {
    manifest,
    errorMessage,
    errorCode,
    loading,
    reload,
    refreshKey: reloadRequest.key,
  };
}

function useSpreadsheetInteractivePreview(
  projectName: string | undefined,
  filePath: string,
  enabled: boolean,
) {
  const [data, setData] = useState<SpreadsheetInteractivePreviewData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [reloadRequest, setReloadRequest] = useState({ key: 0, force: false });
  const lastRequestKeyRef = useRef('');

  const reload = useCallback((options: ReloadOptions = {}) => {
    setReloadRequest((value) => ({
      key: value.key + 1,
      force: Boolean(options.force),
    }));
  }, []);

  useEffect(() => {
    if (!enabled || !projectName) {
      setData(null);
      setLoading(false);
      setErrorMessage(enabled ? 'Project is not available.' : null);
      setErrorCode(null);
      return undefined;
    }

    const requestKey = `spreadsheet-interactive:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;
    const controller = new AbortController();

    if (isNewFile) setData(null);
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    api.spreadsheetInteractivePreview(projectName, filePath, {
      force: reloadRequest.force,
      cacheKey: reloadRequest.key,
      signal: controller.signal,
    })
      .then(async (res: Response) => {
        if (!res.ok) throw await readPreviewErrorResponse(res);
        return res.json();
      })
      .then((nextData: SpreadsheetInteractivePreviewData) => {
        if (controller.signal.aborted) return;
        if (!nextData?.workbook || !Array.isArray(nextData.sheets)) {
          throw new Error('Interactive workbook data is incomplete.');
        }
        setData(nextData);
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        if (isNewFile) setData(null);
        setErrorMessage(error.message || 'Failed to load interactive workbook preview.');
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, filePath, projectName, reloadRequest.force, reloadRequest.key]);

  return {
    data,
    errorMessage,
    errorCode,
    loading,
    reload,
  };
}

function useSpreadsheetSheetPreviewUrl({
  projectName,
  filePath,
  sheetIndex,
  revision,
  refreshKey,
  enabled,
}: {
  projectName: string | undefined;
  filePath: string;
  sheetIndex: number | null;
  revision: string;
  refreshKey: number;
  enabled: boolean;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled || !projectName || sheetIndex === null) {
      setPreviewUrl(null);
      setLoading(false);
      setErrorMessage(null);
      setErrorCode(null);
      return undefined;
    }

    const controller = new AbortController();
    const cacheKey = `${revision}:${refreshKey}`;
    const nextPreviewUrl = api.spreadsheetSheetPreviewUrl(
      projectName,
      filePath,
      sheetIndex,
      { cacheKey },
    );

    setPreviewUrl(null);
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    api.preflightSpreadsheetSheetPreview(projectName, filePath, sheetIndex, {
      cacheKey,
      signal: controller.signal,
    })
      .then(async (res: Response) => {
        if (!res.ok) throw await readPreviewErrorResponse(res);
        await res.arrayBuffer().catch(() => null);
        if (!controller.signal.aborted) setPreviewUrl(nextPreviewUrl);
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        setPreviewUrl(null);
        setErrorMessage(error.message || 'Failed to load worksheet preview.');
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, filePath, projectName, refreshKey, revision, sheetIndex]);

  return { previewUrl, errorMessage, errorCode, loading };
}

function useObjectUrl(blob: Blob | null) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setBlobUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    setBlobUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  return blobUrl;
}

function pathsReferToSameFile(left: string, right: string) {
  const normalize = (value: string) => value
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/');
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function useOfficeAutoRefresh(
  projectName: string | undefined,
  filePath: string,
  reload: (options?: ReloadOptions) => void,
) {
  useEffect(() => {
    const matchesFile = (detail: unknown) => {
      if (!detail || typeof detail !== 'object') return false;
      const payload = detail as { projectName?: string; filePath?: string; path?: string };
      const changedPath = payload.filePath || payload.path;
      if (!changedPath) return false;
      return (!payload.projectName || payload.projectName === projectName)
        && pathsReferToSameFile(changedPath, filePath);
    };

    const handleRefreshEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as { force?: boolean } | undefined;
      if (matchesFile(detail)) {
        reload({ force: detail?.force === true });
      }
    };

    window.addEventListener('pilotdeck:file-updated', handleRefreshEvent);
    window.addEventListener('pilotdeck:files-changed', handleRefreshEvent);
    return () => {
      window.removeEventListener('pilotdeck:file-updated', handleRefreshEvent);
      window.removeEventListener('pilotdeck:files-changed', handleRefreshEvent);
    };
  }, [filePath, projectName, reload]);
}

function useOfficePreviewService() {
  const [status, setStatus] = useState<OfficePreviewStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    readOfficePreviewStatus()
      .then((nextStatus) => {
        setStatus(nextStatus);
      })
      .catch(() => {
        setStatus(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { status, loading, reload };
}

function PreviewSpinner({ label }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
      {label && (
        <p className="text-[12px] text-neutral-500 dark:text-neutral-400">{label}</p>
      )}
    </div>
  );
}

function DownloadButton({ projectName, file }: { projectName?: string; file: CodeEditorFile }) {
  const { t } = useTranslation('codeEditor');
  if (!projectName) return null;

  return (
    <a
      href={api.fileDownloadUrl(projectName, file.path)}
      download={file.name}
      className="rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
    >
      {t('actions.download')}
    </a>
  );
}

function OfficePreviewSettingsButton() {
  const { t } = useTranslation('codeEditor');
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== 'undefined') {
          const openSettings = (window as Window & { openSettings?: (tab?: string) => void }).openSettings;
          openSettings?.('config:officePreview');
        }
      }}
      className="rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
    >
      {t('officePreview.configureService')}
    </button>
  );
}

function FallbackContent({
  title,
  message,
  onClose,
  actions,
}: {
  title: string;
  message: string;
  onClose: () => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation('codeEditor');
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-white p-8 dark:bg-neutral-950">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
          <svg
            className="h-7 w-7 text-neutral-500 dark:text-neutral-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <div>
          <h3 className="mb-1 text-[14px] font-medium text-neutral-900 dark:text-neutral-100">
            {title}
          </h3>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400">{message}</p>
        </div>
        <div className="mt-2 flex items-center justify-center gap-2">
          {actions}
          <button
            onClick={onClose}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-[13px] text-white transition-colors hover:opacity-90 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {t('actions.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImagePreview({ projectName, file, title, message, onClose }: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  message: string;
  onClose: () => void;
}) {
  const { blob, errorMessage, loading } = useFileBlob(projectName, file.path, true);
  const blobUrl = useObjectUrl(blob);
  const [imgError, setImgError] = useState(false);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  if (loading && !blobUrl) return <PreviewSpinner />;
  if (errorMessage || imgError || !blobUrl) {
    return <FallbackContent title={title} message={message} onClose={onClose} />;
  }

  const capabilities: ReferenceCapabilities = {
    text: { state: 'unavailable', reason: 'NO_TEXT_LAYER' },
    cells: { state: 'unavailable', reason: 'NO_CELL_MODEL' },
    region: { state: 'available' },
    recommendedMode: 'region',
  };
  const handleRegionCommit = (capture: CapturedRegion) => {
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source: {
        projectName,
        relativePath: file.path,
        fileName: file.name,
        ...(blob ? { revision: { size: blob.size } } : {}),
      },
      renderer: { id: 'image', backend: 'builtin', locatorQuality: 'visual' },
      locator: { surface: 'page', pageNumber: 1, rect: capture.rect },
      image: {
        name: `reference-${file.name}-${Date.now()}.png`,
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
    <div className="flex h-full w-full flex-col bg-neutral-50 dark:bg-neutral-900">
      <div className="flex h-11 shrink-0 items-center justify-end border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-950">
        <ContentReferenceMenu
          capabilities={capabilities}
          activeMode={referenceMode}
          onSelectMode={(mode) => setReferenceMode(mode === 'region' ? mode : null)}
          onCancelMode={() => setReferenceMode(null)}
        />
      </div>
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          ref={imageRef}
          src={blobUrl}
          alt={file.name}
          className="max-h-full max-w-full rounded object-contain"
          onError={() => setImgError(true)}
        />
        <RegionSelectionOverlay
          active={referenceMode === 'region'}
          hostRef={viewportRef}
          resolveTarget={(element) => {
            const image = element?.closest<HTMLImageElement>('img');
            if (!image || image !== imageRef.current) return null;
            return { element: image, surface: 'page', pageNumber: 1 };
          }}
          onCommit={handleRegionCommit}
          onCancel={() => setReferenceMode(null)}
        />
      </div>
    </div>
  );
}

function PdfPreview({
  projectName,
  file,
  title,
  message,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  message: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const basePreviewUrl = projectName ? api.fileContentUrl(projectName, file.path) : null;
  const previewUrl = basePreviewUrl
    ? `${basePreviewUrl}${basePreviewUrl.includes('?') ? '&' : '?'}previewRevision=${refreshKey}`
    : null;

  if (!previewUrl) {
    return <FallbackContent title={title} message={message} onClose={onClose} />;
  }

  return (
    <PdfDocumentPreview
      url={previewUrl}
      projectName={projectName}
      fileName={file.name}
      filePath={file.path}
      source="pdf"
      navigationMode="pages"
      onRefresh={() => setRefreshKey((value) => value + 1)}
      downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
      downloadName={file.name}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}

function SpreadsheetPreviewToolbar({
  zoom,
  projectName,
  file,
  isFullscreen,
  refreshing,
  onZoomChange,
  onRefresh,
  onToggleFullscreen,
}: {
  zoom: number;
  projectName?: string;
  file: CodeEditorFile;
  isFullscreen: boolean;
  refreshing: boolean;
  onZoomChange: (zoom: number) => void;
  onRefresh: () => void;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const iconButtonClass = 'flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800';

  return (
    <div className="flex h-11 shrink-0 items-center justify-end gap-3 border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(0.25, zoom - 0.1))}
          className={iconButtonClass}
          title={t('pdfToolbar.zoomOut')}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" strokeWidth="1.75" />
            <path d="M8 11h6m2.5 5.5L21 21" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        <span className="min-w-[52px] text-center text-[12px] tabular-nums text-neutral-600 dark:text-neutral-300">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => onZoomChange(Math.min(2, zoom + 0.1))}
          className={iconButtonClass}
          title={t('pdfToolbar.zoomIn')}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" strokeWidth="1.75" />
            <path d="M8 11h6m-3-3v6m5.5 2.5L21 21" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        <span className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-800" />
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className={iconButtonClass}
          title={t('pdfToolbar.refresh')}
        >
          <svg
            className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M20 7v5h-5M4 17v-5h5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
            <path d="M6.1 8.5A7 7 0 0118.5 7M17.9 15.5A7 7 0 015.5 17" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        {onToggleFullscreen && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={iconButtonClass}
            title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d={isFullscreen
                  ? 'M9 9H4V4m5 5L3.5 3.5M15 9h5V4m-5 5l5.5-5.5M9 15H4v5m5-5l-5.5 5.5M15 15h5v5m-5-5l5.5 5.5'
                  : 'M4 9V4h5M4 4l5.5 5.5M20 9V4h-5m5 0l-5.5 5.5M4 15v5h5m-5 0l5.5-5.5M20 15v5h-5m5 0l-5.5-5.5'}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
              />
            </svg>
          </button>
        )}
        {projectName && (
          <a
            href={api.fileDownloadUrl(projectName, file.path)}
            download={file.name}
            className={iconButtonClass}
            title={t('actions.download')}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}

function SpreadsheetPreview({
  service,
  projectName,
  file,
  title,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  service: OfficePreviewService;
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const [zoom, setZoom] = useState(1);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const usePrintPreview = service === 'libreoffice';
  const interactiveEnabled = !usePrintPreview;
  const {
    data: interactiveData,
    errorMessage: interactiveError,
    loading: interactiveLoading,
    reload: reloadInteractive,
  } = useSpreadsheetInteractivePreview(projectName, file.path, interactiveEnabled);
  const interactiveFailure = interactiveError || runtimeError;
  const printPreviewEnabled = usePrintPreview;
  const {
    manifest,
    errorMessage: manifestError,
    errorCode: manifestErrorCode,
    loading: manifestLoading,
    reload: reloadPrint,
    refreshKey,
  } = useSpreadsheetPreviewManifest(projectName, file.path, printPreviewEnabled);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState<number | null>(null);

  const reload = useCallback((options: ReloadOptions = {}) => {
    setRuntimeError(null);
    if (!usePrintPreview) reloadInteractive(options);
    else reloadPrint(options);
  }, [reloadInteractive, reloadPrint, usePrintPreview]);

  useOfficeAutoRefresh(projectName, file.path, reload);

  useEffect(() => {
    setZoom(1);
    setRuntimeError(null);
    setSelectedSheetIndex(null);
  }, [file.path]);

  const activeManifest = usePrintPreview ? manifest : interactiveData;

  useEffect(() => {
    if (!activeManifest) return;
    setSelectedSheetIndex((current) => (
      current !== null && activeManifest.sheets.some((sheet) => sheet.index === current)
        ? current
        : activeManifest.sheets.some((sheet) => sheet.index === activeManifest.activeSheetIndex)
          ? activeManifest.activeSheetIndex
          : activeManifest.sheets[0]?.index ?? null
    ));
  }, [activeManifest]);

  const {
    previewUrl,
    errorMessage: sheetError,
    errorCode: sheetErrorCode,
    loading: sheetLoading,
  } = useSpreadsheetSheetPreviewUrl({
    projectName,
    filePath: file.path,
    sheetIndex: selectedSheetIndex,
    revision: manifest?.revision || '',
    refreshKey,
    enabled: printPreviewEnabled && Boolean(manifest) && selectedSheetIndex !== null,
  });

  let sheetContent: ReactNode;
  if (!usePrintPreview) {
    if (interactiveLoading && !interactiveData) {
      sheetContent = <PreviewSpinner label={t('spreadsheetPreview.readingWorkbook')} />;
    } else if (interactiveFailure || !interactiveData || selectedSheetIndex === null) {
      sheetContent = (
        <FallbackContent
          title={title}
          message={interactiveFailure || t('spreadsheetPreview.interactiveFailedMessage')}
          onClose={onClose}
          actions={(
            <>
              <DownloadButton projectName={projectName} file={file} />
              <OfficePreviewSettingsButton />
            </>
          )}
        />
      );
    } else {
      sheetContent = (
        <Suspense fallback={<PreviewSpinner label={t('spreadsheetPreview.loadingInteractive')} />}>
          <SpreadsheetInteractivePreview
            key={interactiveData.revision}
            workbook={interactiveData.workbook}
            projectName={projectName}
            fileName={file.name}
            filePath={file.path}
            revision={interactiveData.revision}
            activeSheetIndex={selectedSheetIndex}
            zoom={zoom}
            onActiveSheetChange={setSelectedSheetIndex}
            onError={(error) => setRuntimeError(error.message)}
          />
        </Suspense>
      );
    }
  } else if (manifestLoading && !manifest) {
    sheetContent = <PreviewSpinner label={t('spreadsheetPreview.readingWorkbook')} />;
  } else if (manifestError || !manifest) {
    const needsLibreOffice = manifestErrorCode === 'LIBREOFFICE_NOT_FOUND';
    sheetContent = (
      <FallbackContent
        title={needsLibreOffice ? t('officePreview.libreOfficeUnavailableTitle') : title}
        message={needsLibreOffice
          ? t('officePreview.libreOfficeUnavailableMessage')
          : manifestError || t('spreadsheetPreview.failedMessage')}
        onClose={onClose}
        actions={(
          <>
            <DownloadButton projectName={projectName} file={file} />
            {needsLibreOffice && <OfficePreviewSettingsButton />}
          </>
        )}
      />
    );
  } else {
    const needsLibreOffice = sheetErrorCode === 'LIBREOFFICE_NOT_FOUND';
    if (sheetLoading || selectedSheetIndex === null) {
      sheetContent = <PreviewSpinner label={t('spreadsheetPreview.renderingSheet')} />;
    } else if (sheetError || !previewUrl) {
      sheetContent = (
        <FallbackContent
          title={needsLibreOffice ? t('officePreview.libreOfficeUnavailableTitle') : title}
          message={needsLibreOffice
            ? t('officePreview.libreOfficeUnavailableMessage')
            : sheetError || t('spreadsheetPreview.failedMessage')}
          onClose={onClose}
          actions={(
            <>
              <DownloadButton projectName={projectName} file={file} />
              {needsLibreOffice && <OfficePreviewSettingsButton />}
            </>
          )}
        />
      );
    } else {
      sheetContent = (
        <PdfDocumentPreview
          url={previewUrl}
          projectName={projectName}
          fileName={file.name}
          filePath={file.path}
          source="office-pdf"
          viewKey={`worksheet:${selectedSheetIndex}`}
          loadingOverlay={manifestLoading ? t('officePreview.refreshing') : null}
          navigationMode="none"
          showPageControls={false}
          onRefresh={() => reloadPrint({ force: true })}
          refreshDisabled={manifestLoading || sheetLoading}
          downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
          downloadName={file.name}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      );
    }
  }

  const previewWarning = !usePrintPreview
    ? interactiveData?.warnings?.[0]
    : null;
  const warning = previewWarning
    ? t(`spreadsheetPreview.warnings.${previewWarning.code}`, {
      defaultValue: previewWarning.message,
    })
    : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      {!usePrintPreview && (
        <SpreadsheetPreviewToolbar
          zoom={zoom}
          projectName={projectName}
          file={file}
          isFullscreen={isFullscreen}
          refreshing={interactiveLoading}
          onZoomChange={setZoom}
          onRefresh={() => reload({ force: true })}
          onToggleFullscreen={onToggleFullscreen}
        />
      )}
      {warning && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          {warning}
        </div>
      )}
      <div className="min-h-0 flex-1">{sheetContent}</div>
      {activeManifest && (
        <SpreadsheetTabs
          sheets={activeManifest.sheets}
          activeSheetIndex={selectedSheetIndex ?? activeManifest.activeSheetIndex}
          disabled={usePrintPreview ? manifestLoading : interactiveLoading}
          onSelect={setSelectedSheetIndex}
        />
      )}
    </div>
  );
}

function OfficePreview({
  projectName,
  file,
  title,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const { previewUrl, errorMessage, errorCode, loading, reload } = useOfficePdfPreviewUrl(projectName, file.path, true);

  useOfficeAutoRefresh(projectName, file.path, reload);

  if (loading && !previewUrl) return <PreviewSpinner label={t('officePreview.converting')} />;
  if (errorMessage || !previewUrl) {
    const needsLibreOffice = errorCode === 'LIBREOFFICE_NOT_FOUND'
      || errorMessage?.includes('LibreOffice')
      || errorMessage === 'LIBREOFFICE_NOT_FOUND';
    const fallbackTitle = needsLibreOffice
      ? t('officePreview.libreOfficeUnavailableTitle')
      : title;
    const fallbackMessage = needsLibreOffice
      ? t('officePreview.libreOfficeUnavailableMessage')
      : errorMessage || t('officePreview.failedMessage');

    return (
      <FallbackContent
        title={fallbackTitle}
        message={fallbackMessage}
        onClose={onClose}
        actions={(
          <>
            <DownloadButton projectName={projectName} file={file} />
            <OfficePreviewSettingsButton />
          </>
        )}
      />
    );
  }

  return (
    <PdfDocumentPreview
      url={previewUrl}
      projectName={projectName}
      fileName={file.name}
      filePath={file.path}
      source="office-pdf"
      loadingOverlay={loading ? t('officePreview.refreshing') : null}
      navigationMode={getPdfNavigationMode(file.name)}
      onRefresh={() => reload({ force: true })}
      refreshDisabled={loading}
      downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
      downloadName={file.name}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}

function BuiltinModernOfficePreview({
  projectName,
  file,
  title,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const { blob, errorMessage, loading, reload } = useFileBlob(
    projectName,
    file.path,
    true,
  );
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const handleReload = useCallback(() => {
    setRuntimeError(null);
    reload({ force: true });
  }, [reload]);
  const handleRuntimeError = useCallback((error: Error) => {
    setRuntimeError(error.message);
  }, []);

  useOfficeAutoRefresh(projectName, file.path, handleReload);
  useEffect(() => {
    setRuntimeError(null);
  }, [file.path]);

  if (loading && !blob) {
    return <PreviewSpinner label={t('officePreview.loadingBuiltin')} />;
  }
  if (errorMessage || runtimeError || !blob) {
    return (
      <FallbackContent
        title={title}
        message={runtimeError || errorMessage || t('officePreview.failedMessage')}
        onClose={onClose}
        actions={(
          <>
            <DownloadButton projectName={projectName} file={file} />
            <OfficePreviewSettingsButton />
          </>
        )}
      />
    );
  }

  const commonProps = {
    blob,
    projectName,
    fileName: file.name,
    filePath: file.path,
    downloadUrl: projectName ? api.fileDownloadUrl(projectName, file.path) : null,
    downloadName: file.name,
    isFullscreen,
    onToggleFullscreen,
    refreshing: loading,
    onRefresh: handleReload,
    onError: handleRuntimeError,
  };

  return (
    <Suspense fallback={<PreviewSpinner label={t('officePreview.loadingBuiltin')} />}>
      {isWordFile(file.name)
        ? <DocxBuiltinPreview {...commonProps} />
        : <PptxBuiltinPreview {...commonProps} />}
    </Suspense>
  );
}

function OfficeFilePreviewRouter({
  projectName,
  file,
  title,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const { status, loading } = useOfficePreviewService();
  const service = status?.service || 'builtin';

  if (loading) {
    return <PreviewSpinner label={t('officePreview.checkingService')} />;
  }
  if (service === 'libreoffice') {
    return isSpreadsheetFile(file.name)
      ? (
        <SpreadsheetPreview
          service={service}
          projectName={projectName}
          file={file}
          title={title}
          onClose={onClose}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      )
      : (
        <OfficePreview
          projectName={projectName}
          file={file}
          title={title}
          onClose={onClose}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      );
  }

  if (!isBuiltinOfficeFile(file.name)) {
    return (
      <FallbackContent
        title={t('officePreview.unsupportedBuiltinTitle')}
        message={t('officePreview.unsupportedBuiltinMessage', {
          extension: `.${getExtension(file.name)}`,
        })}
        onClose={onClose}
        actions={(
          <>
            <DownloadButton projectName={projectName} file={file} />
            <OfficePreviewSettingsButton />
          </>
        )}
      />
    );
  }

  if (isSpreadsheetFile(file.name)) {
    return (
      <SpreadsheetPreview
        service={service}
        projectName={projectName}
        file={file}
        title={title}
        onClose={onClose}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }

  return (
    <BuiltinModernOfficePreview
      projectName={projectName}
      file={file}
      title={title}
      onClose={onClose}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}

export default function CodeEditorBinaryFile({
  file,
  projectName,
  isSidebar,
  compactHeader = false,
  isFullscreen,
  isExpanded = false,
  onClose,
  onToggleFullscreen,
  onToggleExpand = null,
  title,
  message,
  headerPrefix,
}: CodeEditorBinaryFileProps) {
  const { t } = useTranslation('codeEditor');
  const iconBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

  const isImage = isImageFile(file.name);
  const isPdf = isPdfFile(file.name);
  const isOffice = isOfficeFile(file.name);
  const canPreview = isImage || isPdf || isOffice;
  const hasEmbeddedDocumentToolbar = isPdf || isOffice;
  const documentIsFullscreen = isSidebar ? isExpanded : isFullscreen;
  const onToggleDocumentFullscreen = isSidebar ? onToggleExpand : onToggleFullscreen;

  const previewContent = isImage
    ? <ImagePreview projectName={projectName} file={file} title={title} message={message} onClose={onClose} />
    : isPdf
      ? (
        <PdfPreview
          projectName={projectName}
          file={file}
          title={title}
          message={message}
          onClose={onClose}
          isFullscreen={documentIsFullscreen}
          onToggleFullscreen={onToggleDocumentFullscreen}
        />
      )
      : isOffice
        ? (
          <OfficeFilePreviewRouter
            projectName={projectName}
            file={file}
            title={title}
            onClose={onClose}
            isFullscreen={documentIsFullscreen}
            onToggleFullscreen={onToggleDocumentFullscreen}
          />
        )
        : <FallbackContent title={title} message={message} onClose={onClose} />;

  const headerTopBar = (
    <div
      className={compactHeader
        ? 'absolute right-2 top-1 z-10 flex h-8 items-center rounded-md bg-neutral-50 px-1 dark:bg-neutral-900'
        : 'flex flex-shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950'}
    >
      {!compactHeader && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileTypeBadge fileName={file.name} />
          <h3 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
            {file.name}
          </h3>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        {!isSidebar && !hasEmbeddedDocumentToolbar && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={iconBtn}
            title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
          >
            {isFullscreen ? (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
                  d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5"
                />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
                  d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                />
              </svg>
            )}
          </button>
        )}
        {!headerPrefix ? (
          <button type="button" onClick={onClose} className={iconBtn} title={t('actions.close')}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.75}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );

  if (isSidebar) {
    return (
      <div className="relative flex h-full w-full flex-col bg-white dark:bg-neutral-950">
        {headerPrefix}
        {!compactHeader || !headerPrefix ? headerTopBar : null}
        {previewContent}
      </div>
    );
  }

  const containerClassName = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-white dark:bg-neutral-950 flex flex-col'
    : 'fixed inset-0 z-[9999] md:bg-black/40 md:backdrop-blur-sm md:flex md:items-center md:justify-center md:p-4';

  const innerClassName = isFullscreen
    ? 'bg-white dark:bg-neutral-950 flex flex-col w-full h-full'
    : `bg-white dark:bg-neutral-950 flex flex-col w-full h-full md:rounded-xl md:border md:border-neutral-200 dark:md:border-neutral-800 md:shadow-xl ${
      canPreview
        ? 'md:w-full md:max-w-5xl md:h-[85vh] md:max-h-[85vh]'
        : 'md:w-full md:max-w-2xl md:h-auto md:max-h-[60vh]'
    }`;

  return (
    <div className={containerClassName}>
      <div className={innerClassName}>
        {headerPrefix}
        {headerTopBar}
        {previewContent}
      </div>
    </div>
  );
}
