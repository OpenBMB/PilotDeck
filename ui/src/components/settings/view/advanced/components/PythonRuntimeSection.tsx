import { useEffect, useState } from 'react';
import { Code2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PilotDeckConfig } from '../../modelPool/types';
import type { PythonRuntimeStatus } from '../../../../../../../src/runtime/pythonRuntime';
import { patch } from '../../modelPool/utils/patch';
import SettingsToggle from '../../../shared/view/SettingsToggle';
import { authenticatedFetch } from '../../../../../utils/api';

export default function PythonRuntimeSection({ config, onSave, saving }: {
  config: PilotDeckConfig; onSave: (next: PilotDeckConfig) => Promise<boolean>; saving: boolean;
}) {
  const { t } = useTranslation('settings');
  const enabled = config.runtime?.python?.enabled !== false;
  const [status, setStatus] = useState<PythonRuntimeStatus | null>(null);
  const [checking, setChecking] = useState(true), [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false), [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setChecking(true); setFailed(false); setStatus(null);
    void authenticatedFetch('/api/config/python-runtime').then(async response => {
      if (!response.ok) throw new Error('Status unavailable');
      const value: PythonRuntimeStatus = await response.json();
      if (!['ready', 'disabled', 'external', 'unavailable'].includes(value.state)) throw new Error('Invalid status');
      if (active) setStatus(value);
    }).catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [enabled, revision]);
  const save = async (value: boolean) => {
    setPending(true); setNotice('');
    try {
      const ok = await onSave(patch(config, ['runtime', 'python', 'enabled'], value));
      setNotice(t(ok ? 'pythonRuntime.saved' : 'pythonRuntime.saveFailed'));
      if (ok) setRevision(current => current + 1);
    } catch { setNotice(t('pythonRuntime.saveFailed')); }
    finally { setPending(false); }
  };
  return <section className="advanced-system-section" aria-labelledby="python-runtime-title">
    <div className="advanced-settings-card">
      <header className="agent-retry-header advanced-card-header">
        <span className="agent-retry-icon"><Code2 size={19} /></span>
        <span><strong id="python-runtime-title">{t('pythonRuntime.title')}</strong><small>{t('pythonRuntime.description')}</small></span>
      </header>
      <div className="runtime-logs-content">
        <div className="runtime-logs-row">
          <div className="advanced-service-copy"><strong>{t('pythonRuntime.enable')}</strong><p>{t('pythonRuntime.toggleHint')}</p></div>
          <SettingsToggle checked={enabled} onChange={value => void save(value)} ariaLabel={t('pythonRuntime.enable')}
            disabled={saving || pending} showSuccessToast={false} />
        </div>
        <p role="status" className="text-xs text-muted-foreground">{t(`pythonRuntime.${checking ? 'checking' : failed ? 'statusFailed' : status?.state ?? 'unavailable'}`)}{status?.state === 'ready' && ` · Python ${status.version}`}</p>
        {status?.state === 'ready' && <>
          <p className="break-all text-xs text-muted-foreground">{t('pythonRuntime.interpreter')}: <code>{status.executable}</code></p>
          <p className="text-xs text-muted-foreground">{t('pythonRuntime.libraries')}: {Object.keys(status.packages ?? {}).join(', ')}</p>
        </>}
        <div className="runtime-logs-actions"><button type="button" className="button secondary compact" disabled={checking || pending || saving} onClick={() => setRevision(current => current + 1)}>{t('pythonRuntime.refresh')}</button></div>
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      </div>
    </div>
  </section>;
}
