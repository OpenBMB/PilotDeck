import { useTranslation } from 'react-i18next';
import { Check, Loader2, AlertCircle } from 'lucide-react';
import { formatUploadBytes, uploadFileName, type WorkspaceUpload } from './useWorkspaceUpload';
import './workspace-upload.css';

type Props = { upload: WorkspaceUpload | null; onCancel: () => void; onRetry: () => void; onDismiss: () => void };
export function WorkspaceUploadStatus({ upload, onCancel, onRetry, onDismiss }: Props) {
  const { t } = useTranslation();
  if (!upload) return null;
  const { stage, files, percent, savedNames, failures } = upload;
  if (stage === 'failed' && upload.errorCode === 'UPLOAD_FILE_EXISTS' && savedNames.length === 0) {
    return (
      <section className="workspace-upload" data-stage={stage} aria-label={t('fileTree.uploadStatus.label')}>
        <div className="workspace-upload-heading">
          <span className="workspace-upload-title" role="alert">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{t('fileTree.uploadStatus.failedTitle')}</span>
          </span>
          <button type="button" onClick={onDismiss}>{t('fileTree.uploadStatus.dismiss')}</button>
        </div>
        <div className="workspace-upload-meta">{t('fileTree.uploadStatus.fileExists')}</div>
      </section>
    );
  }
  const busy = ['preparing', 'uploading', 'saving'].includes(stage);
  const status = t(`fileTree.uploadStatus.${stage}`, { count: stage === 'failed' ? failures.length || upload.retryFiles.length || files.length : files.length });
  return (
    <section className="workspace-upload" data-stage={stage} aria-label={t('fileTree.uploadStatus.label')}>
      <div className="workspace-upload-heading">
        <span className="workspace-upload-title" role="status">
          {stage === 'completed' ? <Check size={14} aria-hidden="true" /> : stage === 'failed' ? <AlertCircle size={14} aria-hidden="true" /> : busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
          <span>{status}</span>
        </span>
        {stage === 'uploading' && <span className="workspace-upload-number">{Math.floor(percent)}%</span>}
        {stage === 'preparing' || stage === 'uploading' ? <button type="button" onClick={onCancel}>{t('fileTree.uploadStatus.cancel')}</button> : null}
        {!busy && stage !== 'completed' && upload.retryFiles.length > 0 && <button type="button" onClick={onRetry}>{t('fileTree.uploadStatus.retry')}</button>}
        {!busy && <button type="button" onClick={onDismiss}>{t('fileTree.uploadStatus.dismiss')}</button>}
      </div>
      {busy && <div className="workspace-upload-track" role="progressbar" aria-label={t('fileTree.uploadStatus.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={stage === 'preparing' || stage === 'saving' ? undefined : percent}>
        <div style={{ width: `${stage === 'saving' ? 100 : percent}%` }} />
      </div>}
      <div className="workspace-upload-meta">
        <span className="workspace-upload-name" title={files.map(uploadFileName).join('\n')}>{files.length === 1 ? uploadFileName(files[0]) : t('fileTree.uploadStatus.fileCount', { count: files.length })}</span>
        <span className="workspace-upload-number">{stage === 'completed' ? formatUploadBytes(upload.totalBytes) : `${formatUploadBytes(upload.uploadedBytes)} / ${formatUploadBytes(upload.totalBytes)}`}</span>
      </div>
      {upload.error && <div className="workspace-upload-error" role="alert">{upload.error}</div>}
      {(files.length > 1 || failures.length > 0) && <details className="workspace-upload-details">
        <summary>{t('fileTree.uploadStatus.details')}</summary>
        <ul>{files.map(file => {
          const name = uploadFileName(file);
          const failure = failures.find(item => item.name === name);
          return <li key={name}><span className="workspace-upload-name" title={name}>{name}</span><span>{failure?.message || (savedNames.includes(name) ? t('fileTree.uploadStatus.saved') : t(stage === 'failed' && upload.uploadedBytes === 0 ? 'fileTree.uploadStatus.notUploaded' : 'fileTree.uploadStatus.inBatch'))}</span></li>;
        })}</ul>
      </details>}
    </section>
  );
}
