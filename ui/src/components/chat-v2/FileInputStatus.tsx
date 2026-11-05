import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../chat/types/types';

/** Preparation is model output, not a filesystem write or a percentage of an unknown total. */
export function FileInputStatus({ activity }: { activity: ChatMessage }) {
  const { t } = useTranslation('chat');
  const progress = activity.fileInputProgress;
  if (!progress) return null;
  const write = /^(write|write_file)$/i.test(activity.toolName || '');
  const filePath = typeof progress.filePath === 'string' ? progress.filePath : '';
  const bytes = Number.isFinite(progress.receivedBytes) ? Math.max(0, progress.receivedBytes) : 0;
  return <div data-file-input-status={activity.activityId} className="chat-process-trigger" role="status" aria-live="polite">
    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" strokeWidth={1.8} />
    <span className="shrink-0">{t(write ? 'filePreparation.write' : 'filePreparation.edit')}</span>
    {filePath && <span className="min-w-0 truncate" title={filePath}>{filePath.replace(/\\/g, '/').split('/').pop()}</span>}
    {bytes > 0 && <span data-file-input-size className="shrink-0 tabular-nums text-muted-foreground" aria-live="off">
      {t('filePreparation.received', { kilobytes: (bytes / 1024).toFixed(1) })}
    </span>}
  </div>;
}
