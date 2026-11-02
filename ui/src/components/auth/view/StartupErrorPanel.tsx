import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { startupFailure, startupLabels } from '../../../../../apps/desktop/src/startupPresentation';
import StartupFrame from './StartupFrame';
import { authenticatedFetch } from '../../../utils/api';

export default function StartupErrorPanel({ error, logPath, onRetry, children }: {
  error: string; logPath?: string | null; onRetry: () => void | Promise<void>; children?: ReactNode;
}) {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const labels = startupLabels(language), failure = startupFailure(error, language);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const save = async () => {
    setBusy(true); setNotice('');
    try {
      if (window.pilotdeckDesktop?.saveRuntimeLogs) {
        const result = await window.pilotdeckDesktop.saveRuntimeLogs();
        if (!result.canceled) setNotice(labels.saved);
      } else {
        const response = await authenticatedFetch('/api/diagnostics/logs');
        if (!response.ok) throw new Error('Log download failed');
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'PilotDeck-runtime.log'; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch { setNotice(labels.saveFailed); }
    finally { setBusy(false); }
  };
  return <StartupFrame error>
    <section role="alert" className="pd-startup-failure">
      <h2 className="text-lg font-semibold leading-[26px]">{labels.failed}</h2>
      <p className="my-3 text-sm leading-[22px]">{failure.reason}</p>
      <p className="text-xs leading-[18px] text-muted-foreground">{failure.code}</p>
      {(logPath || failure.logPath) && <p className="mb-5 mt-2 break-all text-xs leading-[18px] text-muted-foreground">{labels.log}: {logPath || failure.logPath}</p>}
      {children}
      <div className="mt-5 flex gap-2.5">
        <button type="button" className="flex-1 rounded-md bg-foreground px-3 py-2.5 text-sm font-medium text-background" onClick={() => void onRetry()}>{labels.restart}</button>
        <button type="button" disabled={busy} className="flex-1 rounded-md border px-3 py-2.5 text-sm font-medium disabled:opacity-60" onClick={() => void save()}>{labels.save}</button>
      </div>
      {notice && <p role="status" className="mt-3 text-xs text-muted-foreground">{notice}</p>}
    </section>
  </StartupFrame>;
}
