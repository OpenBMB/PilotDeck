import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComputerUseStatus } from '../../../../../shared/computerUse';
import { SettingsCard, SettingsSection } from '../../shared/view';
import SettingsToggle from '../../shared/view/SettingsToggle';
import { computerUseApi } from './api';

function Icon({ name, size = 14, className = '' }: { name: 'check' | 'circle' | 'refresh' | 'stop'; size?: number; className?: string }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {name === 'circle' && <circle cx="12" cy="12" r="9" />}
    {name === 'check' && <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>}
    {name === 'refresh' && <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1" /></>}
    {name === 'stop' && <rect x="5" y="5" width="14" height="14" rx="2" />}
  </svg>;
}

export default function ComputerUseSections() {
  const { t } = useTranslation('settings');
  const bridge = computerUseApi;
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pathCopied, setPathCopied] = useState(false);
  const permissionOwner = status?.permissionOwner || 'PilotDeck';

  useEffect(() => {
    let active = true;
    const read = () => bridge.status().then(value => { if (active) { setStatus(value); setLoadError(''); } })
      .catch(caught => { if (active) setLoadError(String(caught.message || caught)); });
    void read();
    const interval = window.setInterval(() => { void read(); }, 3000);
    return () => { active = false; window.clearInterval(interval); };
  }, [bridge]);

  const run = async (operation: () => Promise<ComputerUseStatus>) => {
    setBusy(true); setError('');
    try { setStatus(await operation()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-6">
    <SettingsSection title={t('computerUse.controlTitle')}>
      <SettingsCard className="p-5">
        <div className="flex items-center justify-between gap-6">
          <div><div className="text-sm font-medium">{t('computerUse.enable')}</div>
            <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{t('computerUse.enableDescription')}</p></div>
          <SettingsToggle checked={status?.enabled === true} disabled={busy || !status || !status.available}
            ariaLabel={t('computerUse.enable')} showSuccessToast={false}
            onChange={enabled => { void run(() => bridge.setEnabled(enabled)); }} />
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection title={t('computerUse.permissionsTitle')}>
      <SettingsCard divided>
        {status?.permissions ? (['accessibility', 'screenRecording'] as const).map(permission => {
          const granted = status.permissions![permission];
          return <div key={permission} className="flex items-center justify-between gap-4 p-5">
            <div><div className="text-sm font-medium">{t(`computerUse.permissions.${permission}`)}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon name={granted ? 'check' : 'circle'} className={granted ? 'text-green-600' : ''} />
                {t(granted ? 'computerUse.granted' : 'computerUse.notGranted')}
              </div></div>
            <button className="button secondary compact shrink-0 disabled:opacity-50" disabled={busy || !status.available} onClick={() => { void run(() => bridge.requestPermission(permission)); }}>
              {t('computerUse.openPermissions')}
            </button>
          </div>;
        }) : <p className="p-5 text-xs leading-5 text-muted-foreground">
          {t(!status ? 'computerUse.checking' : status.platform === 'win32' ? 'computerUse.windowsPermissions' : 'computerUse.linuxPermissions')}
        </p>}
      </SettingsCard>
      {status?.platform === 'darwin' && <p className="text-xs leading-5 text-muted-foreground">{t('computerUse.permissionHint', { owner: permissionOwner })}</p>}
      {status?.platform === 'darwin' && status.permissionAppPath && <details
        open={status.permissions && (!status.permissions.accessibility || !status.permissions.screenRecording) ? true : undefined}
        className="rounded-lg border bg-muted/20 p-4 text-xs leading-5">
        <summary className="cursor-pointer font-medium">{t('computerUse.permissionFallbackTitle')}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-muted-foreground">{t('computerUse.permissionFallbackIntro', { owner: permissionOwner })}</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>{t('computerUse.permissionFallbackAdd')}</li>
            <li>{t('computerUse.permissionFallbackSelect')}</li>
            <li>{t('computerUse.permissionFallbackFinish')}</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <button className="button secondary compact disabled:opacity-50" disabled={busy || !status.available}
              onClick={() => { void run(() => bridge.revealPermissionApp()); }}>{t('computerUse.revealPermissionApp')}</button>
            <button className="button secondary compact disabled:opacity-50" disabled={busy}
              onClick={async () => {
                setError(''); setPathCopied(false);
                try { await navigator.clipboard.writeText(status.permissionAppPath!); setPathCopied(true); }
                catch { setError(t('computerUse.copyPathFailed')); }
              }}>{t('computerUse.copyPermissionPath')}</button>
            <span role="status" aria-live="polite">{pathCopied ? t('computerUse.permissionPathCopied') : ''}</span>
          </div>
          <p className="text-muted-foreground">{t('computerUse.permissionFallbackPath')}</p>
          <input aria-label={t('computerUse.permissionAppPath')} readOnly value={status.permissionAppPath}
            onFocus={event => event.currentTarget.select()} className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs" />
        </div>
      </details>}
    </SettingsSection>

    <SettingsSection title={t('computerUse.statusTitle')}>
      <SettingsCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="status" aria-live="polite">
            <div className="text-sm font-medium">{status ? t(`computerUse.phases.${status.phase}`) : t('computerUse.checking')}</div>
            {status && <p className="mt-1 text-xs text-muted-foreground">{t('computerUse.version', { version: status.version })}
              {status.desktopSession ? ` · ${status.desktopSession === 'x11' ? 'X11' : status.desktopSession === 'wayland' ? 'Wayland' : t('computerUse.unknownSession')}` : ''}</p>}
          </div>
          <div className="flex gap-2">
            <button className="button secondary compact disabled:opacity-50" disabled={busy || !status} onClick={() => { void run(() => bridge.refresh()); }}>
              <Icon name="refresh" className={busy ? 'animate-spin' : ''} />{t('computerUse.refresh')}
            </button>
            {status?.enabled && <button className="button secondary compact disabled:opacity-50" disabled={busy} onClick={() => { void run(() => bridge.setEnabled(false)); }}>
              <Icon name="stop" />{t('computerUse.stop')}
            </button>}
          </div>
        </div>
        {status?.phase === 'partial' && <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('computerUse.waylandHint')}</p>}
        {(error || loadError || status?.error) && <p role="alert" className="mt-3 text-xs leading-5 text-destructive">{error || loadError || status?.error}</p>}
        {status && !status.available && <p role="alert" className="mt-3 text-xs text-destructive">{t('computerUse.missingDriver')}</p>}
      </SettingsCard>
    </SettingsSection>
  </div>;
}
