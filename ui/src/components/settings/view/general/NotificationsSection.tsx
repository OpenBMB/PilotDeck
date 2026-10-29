import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNotificationPreferences } from '../../../../hooks/useNotificationPreferences';
import { SettingsToggle } from '../../shared/view';
import { GeneralCardHeader, GeneralSettingsIcon, GeneralSettingRow } from '../../shared/view/GeneralSettingsPrimitives';

export default function NotificationsSection() {
  const { t } = useTranslation('settings');
  const { preferences, status, enable, update } = useNotificationPreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(false);
    try { await operation(); } catch { setError(true); } finally { setBusy(false); }
  };
  const desktop = Boolean(window.pilotdeckDesktop);
  const badgeSupported = desktop && window.pilotdeckDesktop?.platform !== 'win32';
  const permissionKey = !status.supported ? desktop ? 'unsupportedDesktop' : 'unsupported' : status.permission === 'denied' ? 'denied'
    : desktop ? 'systemControlled' : status.permission === 'granted' ? 'granted' : 'notGranted';
  return <section className="general-section">
    <article className="general-card" aria-label={t('systemNotifications.title')}>
      <GeneralCardHeader icon={<GeneralSettingsIcon icon={Bell} />} title={t('systemNotifications.title')} />
      <GeneralSettingRow title={t('systemNotifications.enabled')} detail={t('systemNotifications.description')}>
        <SettingsToggle checked={preferences.enabled} disabled={busy || (!status.supported && !preferences.enabled)} showSuccessToast={false}
          ariaLabel={t('systemNotifications.enabled')} onChange={value => { void run(() => enable(value)); }} />
      </GeneralSettingRow>
      {(badgeSupported ? ['sound', 'badge', 'preview'] as const : ['sound', 'preview'] as const).map(key => <GeneralSettingRow key={key}
        title={t(`systemNotifications.${key}`)} detail={t(`systemNotifications.${key}Description`)}>
        <SettingsToggle checked={preferences[key]} disabled={busy || (key !== 'badge' && !preferences.enabled)}
          showSuccessToast={false} ariaLabel={t(`systemNotifications.${key}`)}
          onChange={value => { void run(() => update({ [key]: value })); }} />
      </GeneralSettingRow>)}
      <GeneralSettingRow title={t('systemNotifications.systemSettings')} detail={t(`systemNotifications.${permissionKey}`)}>
        <button type="button" className="general-notification-settings-button" disabled={busy}
          onClick={() => { void run(async () => {
            const opened = await window.pilotdeckDesktop?.openNotificationSettings?.();
            if (!opened) setShowHelp(true);
          }); }}>{t(desktop ? 'systemNotifications.openSettings' : 'systemNotifications.showHelp')}</button>
      </GeneralSettingRow>
      {showHelp && <p className="general-notification-help" role="status">{t(desktop ? 'systemNotifications.desktopHelp' : 'systemNotifications.browserHelp')}</p>}
      {error && <p className="general-notification-help text-red-600" role="alert">{t('systemNotifications.saveError')}</p>}
    </article>
  </section>;
}
