import { GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitRuntimeStatus } from '../../../../../../../src/runtime/gitRuntime';
import { useRuntimeStatus } from './useRuntimeStatus';

const states = ['ready', 'unavailable'];

export default function GitRuntimeSection() {
  const { t } = useTranslation('settings');
  const { status, checking, error, refresh } = useRuntimeStatus<GitRuntimeStatus>('/api/config/git-runtime', states);
  return <section className="advanced-system-section" aria-labelledby="git-runtime-title">
    <div className="advanced-settings-card">
      <header className="agent-retry-header advanced-card-header">
        <span className="agent-retry-icon"><GitBranch size={19} /></span>
        <span><strong id="git-runtime-title">{t('gitRuntime.title')}</strong><small>{t('gitRuntime.description')}</small></span>
      </header>
      <div className="runtime-logs-content">
        <p role="status" className="text-xs text-muted-foreground">{t(`gitRuntime.${checking ? 'checking' : error === 'timeout' ? 'statusTimedOut' : error ? 'statusFailed' : status?.state ?? 'unavailable'}`)}{status?.version && ` · Git ${status.version}`}</p>
        {status?.state === 'ready' && <>
          <p className="text-xs text-muted-foreground">{t(`gitRuntime.sources.${status.source}`)}</p>
          <p className="break-all text-xs text-muted-foreground">{t('gitRuntime.executable')}: <code>{status.executable}</code></p>
        </>}
        <div className="runtime-logs-actions"><button type="button" className="button secondary compact" disabled={checking} onClick={() => void refresh()}>{t('gitRuntime.refresh')}</button></div>
      </div>
    </div>
  </section>;
}
