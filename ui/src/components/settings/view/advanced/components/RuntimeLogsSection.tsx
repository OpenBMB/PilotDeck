import { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PilotDeckConfig } from '../../modelPool/types';
import { patch } from '../../modelPool/utils/patch';
import { authenticatedFetch } from '../../../../../utils/api';
import { saveRuntimeLogs } from '../../../../../utils/runtimeLogExport';

export default function RuntimeLogsSection({ config, onSave, saving }: {
  config: PilotDeckConfig; onSave: (next: PilotDeckConfig) => Promise<boolean>; saving: boolean;
}) {
  const { t } = useTranslation('settings');
  const [logPath, setLogPath] = useState(''), [notice, setNotice] = useState(''), [exporting, setExporting] = useState(false);
  const days = config.webui?.runtime?.logRetentionDays;
  const selected = typeof days === 'number' && [1, 3, 7, 30, 90].includes(days) ? days : 7;
  useEffect(() => {
    let active = true;
    const location = window.pilotdeckDesktop?.getRuntimeInfo
      ? window.pilotdeckDesktop.getRuntimeInfo().then(value => value?.logPath)
      : authenticatedFetch('/api/diagnostics/location').then(response => response.ok ? response.json() : null).then(value => value?.logPath);
    void location.then(value => { if (active && typeof value === 'string') setLogPath(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const saveLogs = async () => {
    setExporting(true); setNotice('');
    try {
      const result = await saveRuntimeLogs(t('runtimeLogs.title'));
      if (result && !result.canceled) setNotice(t('runtimeLogs.saved'));
    } catch { setNotice(t('runtimeLogs.saveFailed')); }
    finally { setExporting(false); }
  };
  return <section className="advanced-system-section runtime-logs-section" aria-labelledby="runtime-logs-title">
    <div className="advanced-settings-card">
      <header className="agent-retry-header advanced-card-header">
        <span className="agent-retry-icon"><FileText size={19} /></span>
        <span><strong id="runtime-logs-title">{t('runtimeLogs.title')}</strong><small>{t('runtimeLogs.description')}</small></span>
      </header>
      <div className="runtime-logs-content">
        <label className="runtime-logs-row" htmlFor="runtime-log-retention">
          <div className="advanced-service-copy"><strong>{t('runtimeLogs.retention')}</strong><p>{t('runtimeLogs.retentionHint')}</p></div>
          <select className="runtime-logs-select" id="runtime-log-retention" value={selected} disabled={saving} onChange={event => {
            setNotice('');
            void onSave(patch(config, ['webui', 'runtime', 'logRetentionDays'], Number(event.target.value))).then(ok => { if (!ok) setNotice(t('runtimeLogs.preferenceFailed')); }).catch(() => setNotice(t('runtimeLogs.preferenceFailed')));
          }}>
            {[1, 3, 7, 30, 90].map(value => <option key={value} value={value}>{t(`runtimeLogs.days${value}`)}</option>)}
          </select>
        </label>
        {logPath && <p className="break-all text-xs text-muted-foreground">{t('runtimeLogs.location')}: {logPath}</p>}
        <div className="runtime-logs-actions"><button className="button secondary compact" type="button" disabled={exporting} onClick={() => void saveLogs()}><Download size={16} />{t('runtimeLogs.save')}</button></div>
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      </div>
    </div>
  </section>;
}
