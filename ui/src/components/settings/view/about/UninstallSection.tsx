import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard } from '../../shared/view';

export default function UninstallSection() {
  const { t } = useTranslation('settings');
  const [supported, setSupported] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.pilotdeckDesktop?.getUninstallStatus?.().then(value => { if (active) setSupported(value.supported); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (window.pilotdeckDesktop?.platform !== 'linux') return null;
  return <SettingsCard className="overflow-hidden">
    <div className="space-y-3 px-5 py-4 text-sm">
      <h3 className="font-medium">{t('uninstall.title')}</h3>
      <p className="text-muted-foreground">{t(supported ? 'uninstall.description' : 'uninstall.systemHint')}</p>
      {supported && <button className="desktop-update-button secondary" type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await window.pilotdeckDesktop?.uninstall?.(); }
        catch { setError(t('uninstall.failed')); }
        finally { setBusy(false); }
      }}>{t('uninstall.title')}</button>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  </SettingsCard>;
}
