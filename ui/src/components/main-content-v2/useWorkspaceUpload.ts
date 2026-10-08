import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api';

export type WorkspaceUploadStage = 'preparing' | 'uploading' | 'saving' | 'completed' | 'failed' | 'cancelled';
export type WorkspaceUpload = {
  stage: WorkspaceUploadStage;
  files: File[];
  targetPath: string;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
  savedNames: string[];
  failures: Array<{ name: string; message: string }>;
  error?: string;
  errorCode?: string;
  retryFiles: File[];
};

export const uploadFileName = (file: File) => file.webkitRelativePath || file.name;
export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes >= 1024 ** 3 ? 'GiB' : bytes >= 1024 ** 2 ? 'MiB' : 'KiB';
  const divisor = unit === 'GiB' ? 1024 ** 3 : unit === 'MiB' ? 1024 ** 2 : 1024;
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

export type WorkspaceUploadController = ReturnType<typeof useWorkspaceUpload>;

export function useWorkspaceUpload(projectName: string | undefined, onFilesSaved?: () => void) {
  const { t } = useTranslation();
  const [upload, setUpload] = useState<WorkspaceUpload | null>(null);
  const active = useRef<AbortController | null>(null);
  const project = useRef(projectName);
  project.current = projectName;

  useEffect(() => {
    setUpload(null);
    return () => {
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, [projectName]);

  useEffect(() => {
    if (upload?.stage !== 'completed') return;
    const timer = window.setTimeout(() => setUpload(current => current === upload ? null : current), 5000);
    return () => window.clearTimeout(timer);
  }, [upload]);

  const start = useCallback(async (input: FileList | File[] | null, targetPath = '') => {
    if (!projectName || !input?.length || active.current) return;
    const files = Array.from(input);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const controller = new AbortController();
    active.current = controller;
    const current = () => active.current === controller && project.current === projectName;
    const update = (patch: Partial<WorkspaceUpload>) => {
      if (current()) setUpload(previous => previous ? { ...previous, ...patch } : previous);
    };
    setUpload({ stage: 'preparing', files, targetPath, percent: 0, uploadedBytes: 0, totalBytes, savedNames: [], failures: [], retryFiles: files });
    let preflightFailed = false;
    try {
      const response = await api.uploadLimits(controller.signal);
      if (!response.ok) throw new Error(t('fileTree.uploadStatus.httpError', { status: response.status }));
      const limits = await response.json();
      if (![limits.maxFileBytes, limits.maxTaskBytes, limits.maxFiles].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new Error(t('fileTree.uploadStatus.invalidResponse'));
      }
      let validationError;
      if (files.length > limits.maxFiles) validationError = t('fileTree.uploadStatus.tooMany', { count: limits.maxFiles });
      const large = files.find(file => file.size > limits.maxFileBytes);
      if (large) validationError = t('fileTree.uploadStatus.tooLarge', { name: large.name, limit: formatUploadBytes(limits.maxFileBytes) });
      if (totalBytes > limits.maxTaskBytes) validationError = t('fileTree.uploadStatus.batchTooLarge', { limit: formatUploadBytes(limits.maxTaskBytes) });
      if (new Set(files.map(uploadFileName)).size !== files.length) validationError = t('fileTree.uploadStatus.duplicateNames');
      if (validationError) { preflightFailed = true; throw new Error(validationError); }
      if (!current() || controller.signal.aborted) return;
      const check = await api.checkWorkspaceUpload(projectName, { targetPath, relativePaths: files.map(uploadFileName) }, controller.signal);
      const checked = await check.json();
      if (!current() || controller.signal.aborted) return;
      if (!check.ok) {
        if (checked.error?.code === 'UPLOAD_FILE_EXISTS' && Array.isArray(checked.conflicts) && checked.conflicts.length) {
          preflightFailed = true;
          update({ failures: checked.conflicts.map((name: string) => ({ name, message: t('fileTree.uploadStatus.fileExists') })) });
          throw Object.assign(new Error(t('fileTree.uploadStatus.fileExists')), { code: 'UPLOAD_FILE_EXISTS' });
        }
        throw new Error(checked.error?.message || t('fileTree.uploadStatus.httpError', { status: check.status }));
      }
      if (checked.success !== true) throw new Error(t('fileTree.uploadStatus.invalidResponse'));
      const formData = new FormData();
      formData.append('targetPath', targetPath);
      formData.append('relativePaths', JSON.stringify(files.map(uploadFileName)));
      formData.append('sizes', JSON.stringify(files.map(file => file.size)));
      files.forEach(file => formData.append('files', file));
      update({ stage: 'uploading' });
      const result = await api.uploadFiles(projectName, formData, {
        signal: controller.signal,
        knownTotalBytes: totalBytes,
        onProgress: (percent: number) => update({ percent, uploadedBytes: Math.min(totalBytes, Math.round(totalBytes * percent / 100)) }),
        onTransferred: () => update({ stage: 'saving', percent: 100, uploadedBytes: totalBytes }),
      });
      if (!current() || controller.signal.aborted) return;
      if (!result.ok) {
        const error = result.body.error;
        throw new Error(typeof error === 'string' ? error : error?.message || t('fileTree.uploadStatus.httpError', { status: result.status }));
      }
      const saved = Array.isArray(result.body.files) ? result.body.files : [];
      const savedNames = files.filter(file => saved.some((item: { name: string; size: number }) => item.name === uploadFileName(file) && item.size === file.size)).map(uploadFileName);
      const failedFiles = files.filter(file => !savedNames.includes(uploadFileName(file)));
      const errors = Array.isArray(result.body.errors) ? result.body.errors : [];
      const failureFor = (file: File) => errors.find((error: { name: string }) => error.name === uploadFileName(file));
      const retryFiles = failedFiles.filter(file => failureFor(file)?.code !== 'UPLOAD_FILE_EXISTS');
      const failures = failedFiles.map(file => ({
        name: uploadFileName(file),
        message: failureFor(file)?.code === 'UPLOAD_FILE_EXISTS'
          ? t('fileTree.uploadStatus.fileExists')
          : failureFor(file)?.message || t('fileTree.uploadStatus.invalidResponse'),
      }));
      update({ stage: failedFiles.length ? 'failed' : 'completed', savedNames, failures, retryFiles, percent: 100, uploadedBytes: totalBytes,
        errorCode: failedFiles.length > 0 && failedFiles.every(file => failureFor(file)?.code === 'UPLOAD_FILE_EXISTS') ? 'UPLOAD_FILE_EXISTS' : undefined,
        error: failedFiles.length ? (files.length === 1 ? failures[0].message
          : t('fileTree.uploadStatus.partial', { failed: failedFiles.length, saved: savedNames.length })) : undefined });
      if (savedNames.length) onFilesSaved?.();
    } catch (error) {
      if (!current()) return;
      if (controller.signal.aborted) {
        update({ stage: 'cancelled' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string })?.code || message;
        update({ stage: 'failed', errorCode: code, error: code === 'UPLOAD_NETWORK_ERROR' ? t('fileTree.uploadStatus.networkError')
          : code === 'UPLOAD_TIMEOUT' ? t('fileTree.uploadStatus.timeout') : message,
        retryFiles: preflightFailed ? [] : files });
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [projectName, onFilesSaved, t]);

  return {
    upload,
    busy: Boolean(upload && ['preparing', 'uploading', 'saving'].includes(upload.stage)),
    start,
    cancel: () => {
      if (upload?.stage === 'preparing' || upload?.stage === 'uploading') active.current?.abort();
    },
    retry: () => { if (upload?.retryFiles.length) void start(upload.retryFiles, upload.targetPath); },
    dismiss: () => { if (!active.current) setUpload(null); },
  };
}
