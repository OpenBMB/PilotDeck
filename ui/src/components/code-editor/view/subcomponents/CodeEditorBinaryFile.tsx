import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../utils/api';
import { readOfficePreviewStatus, type OfficePreviewStatus } from '../../../../utils/officePreviewStatus';
import type { CodeEditorFile } from '../../types/types';
import { isImageFile, isOfficeFile, isPdfFile, isSpreadsheetFile } from '../../utils/binaryFile';
import { getPdfNavigationMode } from '../../utils/documentPreview';
import PdfDocumentPreview from './PdfDocumentPreview';
import SpreadsheetTabs, { type SpreadsheetSheetTab } from './SpreadsheetTabs';

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

function useOfficeAutoRefresh(
  projectName: string | undefined,
  filePath: string,
  reload: (options?: ReloadOptions) => void,
) {
  useEffect(() => {
    const matchesFile = (detail: unknown) => {
      if (!detail || typeof detail !== 'object') return true;
      const payload = detail as { projectName?: string; filePath?: string; path?: string };
      const changedPath = payload.filePath || payload.path;
      return (!payload.projectName || payload.projectName === projectName)
        && (!changedPath || changedPath === filePath);
    };

    const handleRefreshEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as { force?: boolean } | undefined;
      if (matchesFile(detail)) {
        reload({ force: detail?.force === true });
      }
    };

    window.addEventListener('pilotdeck:file-updated', handleRefreshEvent);
    window.addEventListener('pilotdeck:files-changed', handleRefreshEvent);
    window.addEventListener('pilotdeck:agent-turn-complete', handleRefreshEvent);
    return () => {
      window.removeEventListener('pilotdeck:file-updated', handleRefreshEvent);
      window.removeEventListener('pilotdeck:files-changed', handleRefreshEvent);
      window.removeEventListener('pilotdeck:agent-turn-complete', handleRefreshEvent);
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

  if (loading && !blobUrl) return <PreviewSpinner />;
  if (errorMessage || imgError || !blobUrl) {
    return <FallbackContent title={title} message={message} onClose={onClose} />;
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-neutral-50 p-4 dark:bg-neutral-900">
      <img
        src={blobUrl}
        alt={file.name}
        className="max-h-full max-w-full rounded object-contain"
        onError={() => setImgError(true)}
      />
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

function SpreadsheetPreview({
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
  const {
    status: previewServiceStatus,
    loading: previewServiceLoading,
  } = useOfficePreviewService();
  const previewDisabledByConfig = previewServiceStatus?.service === 'none';
  const previewEnabled = !previewServiceLoading && !previewDisabledByConfig;
  const {
    manifest,
    errorMessage: manifestError,
    errorCode: manifestErrorCode,
    loading: manifestLoading,
    reload,
    refreshKey,
  } = useSpreadsheetPreviewManifest(projectName, file.path, previewEnabled);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState<number | null>(null);

  useOfficeAutoRefresh(projectName, file.path, reload);

  useEffect(() => {
    if (!manifest) {
      setSelectedSheetIndex(null);
      return;
    }
    setSelectedSheetIndex((current) => (
      current !== null && manifest.sheets.some((sheet) => sheet.index === current)
        ? current
        : manifest.activeSheetIndex
    ));
  }, [manifest]);

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
    enabled: previewEnabled && Boolean(manifest) && selectedSheetIndex !== null,
  });

  if (previewServiceLoading) {
    return <PreviewSpinner label={t('officePreview.checkingService')} />;
  }
  if (previewDisabledByConfig) {
    return (
      <FallbackContent
        title={t('officePreview.disabledTitle')}
        message={t('officePreview.disabledMessage')}
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
  if (manifestLoading && !manifest) {
    return <PreviewSpinner label={t('spreadsheetPreview.readingWorkbook')} />;
  }
  if (manifestError || !manifest) {
    const needsLibreOffice = manifestErrorCode === 'LIBREOFFICE_NOT_FOUND';
    return (
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
  }

  const needsLibreOffice = sheetErrorCode === 'LIBREOFFICE_NOT_FOUND';
  let sheetContent: ReactNode;
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
        onRefresh={() => reload({ force: true })}
        refreshDisabled={manifestLoading || sheetLoading}
        downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
        downloadName={file.name}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      <div className="min-h-0 flex-1">{sheetContent}</div>
      <SpreadsheetTabs
        sheets={manifest.sheets}
        activeSheetIndex={selectedSheetIndex ?? manifest.activeSheetIndex}
        disabled={manifestLoading}
        onSelect={setSelectedSheetIndex}
      />
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
  const {
    status: previewServiceStatus,
    loading: previewServiceLoading,
  } = useOfficePreviewService();
  const previewDisabledByConfig = previewServiceStatus?.service === 'none';
  const shouldLoadOfficePdf = !previewServiceLoading && !previewDisabledByConfig;
  const { previewUrl, errorMessage, errorCode, loading, reload } = useOfficePdfPreviewUrl(projectName, file.path, shouldLoadOfficePdf);

  useOfficeAutoRefresh(projectName, file.path, reload);

  if (previewServiceLoading && !previewUrl) {
    return <PreviewSpinner label={t('officePreview.checkingService')} />;
  }
  if (previewDisabledByConfig) {
    return (
      <FallbackContent
        title={t('officePreview.disabledTitle')}
        message={t('officePreview.disabledMessage')}
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

  if (loading && !previewUrl) return <PreviewSpinner label={t('officePreview.converting')} />;
  if (errorMessage || !previewUrl) {
    const previewDisabled = errorCode === 'OFFICE_PREVIEW_DISABLED';
    const needsLibreOffice = errorCode === 'LIBREOFFICE_NOT_FOUND'
      || errorMessage?.includes('LibreOffice')
      || errorMessage === 'LIBREOFFICE_NOT_FOUND';
    const fallbackTitle = previewDisabled
      ? t('officePreview.disabledTitle')
      : needsLibreOffice
        ? t('officePreview.libreOfficeUnavailableTitle')
        : title;
    const fallbackMessage = previewDisabled
      ? t('officePreview.disabledMessage')
      : needsLibreOffice
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
            {(previewDisabled || needsLibreOffice) && <OfficePreviewSettingsButton />}
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
  const isSpreadsheet = isSpreadsheetFile(file.name);
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
      : isSpreadsheet
        ? (
          <SpreadsheetPreview
            projectName={projectName}
            file={file}
            title={title}
            onClose={onClose}
            isFullscreen={documentIsFullscreen}
            onToggleFullscreen={onToggleDocumentFullscreen}
          />
        )
      : isOffice
        ? (
          <OfficePreview
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
