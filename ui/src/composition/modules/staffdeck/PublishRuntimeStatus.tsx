import { useTranslation } from 'react-i18next';
import { USER_CONTENT_ATTRIBUTES } from '../../../../plugins/staffdeck-shared/vendor/FormalUserContent';
import { usePublishRuntimeSnapshot } from './publish-runtime-context';

export default function PublishRuntimeStatus() {
  const { t } = useTranslation('staffdeck');
  const { receipts, error } = usePublishRuntimeSnapshot();
  if (!error && !receipts.length) return null;
  return <aside aria-label={t('publishRuntime.title')} aria-live="polite" className="fixed bottom-4 right-4 z-50 max-h-[40vh] max-w-sm overflow-auto rounded-lg border border-amber-400 bg-white p-3 text-sm text-slate-900 shadow-lg dark:bg-slate-900 dark:text-slate-100">
    <h2 className="font-medium">{t('publishRuntime.title')}</h2>
    {error && <p role="alert">{t('publishRuntime.metadataUnavailable')}</p>}
    {receipts.map(row => <div key={row.sopId} className="mt-2 border-t border-slate-200 pt-2">
      <span {...USER_CONTENT_ATTRIBUTES}>{row.sopId}{row.version ? ` / ${row.version}` : ''}</span>
      <p>{t(row.ownerPublished ? 'publishRuntime.published' : 'publishRuntime.publishUnconfirmed')}</p>
      <p>{t(row.snapshotWritten ? 'publishRuntime.snapshotWritten' : 'publishRuntime.snapshotMissing')}</p>
      <p>{t(row.refreshRequested ? 'publishRuntime.refreshRequested' : 'publishRuntime.refreshMissing')}</p>
      <p>{t(row.status === 'failed' ? 'publishRuntime.failed' : row.status === 'awaiting-runtime-observation' ? 'publishRuntime.awaiting' : 'publishRuntime.notRefreshed')}</p>
      {(row.receiptPersisted === false || row.receiptFailure) && <p>{t('publishRuntime.receiptFailed')}</p>}
    </div>)}
  </aside>;
}
