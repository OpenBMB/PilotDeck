import { useEffect, useId, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import FolderBrowserModal from '../../../project-creation-wizard/components/FolderBrowserModal';
import { GeneralCardHeader, GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';
import { showSettingsSuccess } from '../../shared/SettingsSuccessToast';

type WorkspaceSettings = { directory: string; effectiveDirectory: string; defaultDirectory: string; unavailable?: boolean; notice?: { directory: string; originalDirectory: string } | null };
export default function GeneralWorkspaceSection() {
  const { t } = useTranslation('settings');
  const id = useId();
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    void authenticatedFetch('/api/settings/general-workspace', { signal: controller.signal, suppressServerErrorToast: true })
      .then(async response => {
        if (!response.ok) throw new Error();
        const data: WorkspaceSettings = await response.json();
        if (!controller.signal.aborted) { setSettings(data); setDraft(data.directory); }
      }).catch(() => { if (!controller.signal.aborted) setError('loadError'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [loadKey]);
  const save = async (directory: string) => {
    setBusy(true); setError('');
    try {
      const response = await authenticatedFetch('/api/settings/general-workspace', {
        method: 'PUT', body: JSON.stringify({ directory }), suppressServerErrorToast: true,
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.code === 'GENERAL_WORKSPACE_UNSAFE' ? 'unsafeError'
          : data.code === 'GENERAL_WORKSPACE_NOT_EMPTY' ? 'notEmptyError'
          : data.code === 'GENERAL_WORKSPACE_STATE_INVALID' ? 'unavailableError'
          : data.code === 'GENERAL_WORKSPACE_INVALID' ? 'invalidError' : 'saveError');
        return;
      }
      setSettings(data); setDraft(data.directory);
      showSettingsSuccess(t('generalWorkspace.saved'));
    } catch { setError('saveError'); }
    finally { setBusy(false); }
  };
  return <section className="general-section">
    <article className="general-card general-workspace-card" aria-label={t('generalWorkspace.title')} aria-busy={busy}>
      <GeneralCardHeader icon={<GeneralSettingsIcon icon={FolderOpen} />} title={t('generalWorkspace.title')} />
      <div className="general-workspace-content">
        <label htmlFor={id}>{t('generalWorkspace.directory')}</label>
        <p id={`${id}-help`}>{t('generalWorkspace.description')}</p>
        <div className="general-workspace-path">
          <input id={id} type="text" value={draft} disabled={busy || !settings}
            placeholder={settings?.defaultDirectory} aria-describedby={`${id}-help`} onChange={event => setDraft(event.target.value)} />
          <button type="button" className="general-notification-settings-button" disabled={busy || !settings}
            onClick={() => setBrowsing(true)}>{t('generalWorkspace.browse')}</button>
        </div>
        {settings && <p className="general-workspace-current">{t('generalWorkspace.current', { path: settings.effectiveDirectory })}</p>}
        {settings?.notice && <p role="status">{t('generalWorkspace.defaultAdjusted', settings.notice)}</p>}
        {settings?.unavailable && <p role="alert">{t('generalWorkspace.unavailableError')}</p>}
        <div className="general-workspace-actions">
          <button type="button" className="general-notification-settings-button" disabled={busy || !settings || !settings.directory}
            onClick={() => void save('')}>{t('generalWorkspace.reset')}</button>
          <button type="button" className="general-notification-settings-button" disabled={busy || !settings || draft.trim() === settings.directory}
            onClick={() => void save(draft)}>{t('generalWorkspace.save')}</button>
          {error === 'loadError' && <button type="button" className="general-notification-settings-button" disabled={busy}
            onClick={() => setLoadKey(value => value + 1)}>{t('generalWorkspace.retry')}</button>}
        </div>
        {error && <p role="alert">{t(`generalWorkspace.${error}`)}</p>}
      </div>
    </article>
    {browsing && <FolderBrowserModal isOpen initialPath={draft || settings?.effectiveDirectory} autoAdvanceOnSelect={false}
      onClose={() => setBrowsing(false)} onFolderSelected={directory => { setDraft(directory); setBrowsing(false); }} />}
  </section>;
}
