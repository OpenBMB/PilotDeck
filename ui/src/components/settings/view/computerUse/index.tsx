import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Circle, CircleCheck, MousePointer2, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { ComputerUseStatus } from '../../../../../shared/computerUse';
import { GeneralCardHeader, GeneralSettingRow, GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';
import SettingsToggle from '../../shared/view/SettingsToggle';
import { computerUseApi } from './api';

export default function ComputerUseSections() {
  const { t } = useTranslation('settings');
  const bridge = computerUseApi;
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pathCopied, setPathCopied] = useState(false);
  const requestSequence = useRef(0);
  const operationPending = useRef(false);
  const permissionOwner = status?.permissionOwner || 'PilotDeck';

  useEffect(() => {
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading || operationPending.current) return;
      reading = true;
      const sequence = ++requestSequence.current;
      try {
        const value = await bridge.status();
        if (active && sequence === requestSequence.current) { setStatus(value); setLoadError(''); }
      } catch (caught) {
        if (active && sequence === requestSequence.current) setLoadError(caught instanceof Error ? caught.message : String(caught));
      } finally { reading = false; }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void read(); };
    void read();
    const interval = window.setInterval(() => { void read(); }, 3000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [bridge]);

  const run = async (operation: () => Promise<ComputerUseStatus>) => {
    operationPending.current = true; ++requestSequence.current;
    setBusy(true); setError('');
    try { setStatus(await operation()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { operationPending.current = false; setBusy(false); }
  };
  return <div className="general-page-content computer-use-content">
    <section className="general-section">
      <article className="general-card">
        <GeneralCardHeader icon={<GeneralSettingsIcon icon={MousePointer2} />} title={t('computerUse.controlTitle')} />
        <GeneralSettingRow title={t('computerUse.enable')} detail={t('computerUse.enableDescription')}>
          <SettingsToggle checked={status?.enabled === true} disabled={busy || !status || !status.available}
            ariaLabel={t('computerUse.enable')} showSuccessToast={false}
            onChange={enabled => { void run(() => bridge.setEnabled(enabled)); }} />
        </GeneralSettingRow>
      </article>
    </section>

    <section className="general-section">
      <article className="general-card">
        <GeneralCardHeader icon={<GeneralSettingsIcon icon={ShieldCheck} />} title={t('computerUse.permissionsTitle')} />
        {status?.permissions ? (['accessibility', 'screenRecording'] as const).map(permission => {
          const granted = status.permissions![permission];
          return <div key={permission} className="general-setting-row general-toggle-row computer-use-permission-row">
            <div className="general-setting-copy"><strong className="general-setting-title">{t(`computerUse.permissions.${permission}`)}</strong>
              <div className="computer-use-permission-state" data-granted={granted === true}>
                <GeneralSettingsIcon icon={granted ? CircleCheck : Circle} />
                {t(granted === null ? (status.error ? 'computerUse.permissionCheckFailed' : 'computerUse.checking') : granted ? 'computerUse.granted' : 'computerUse.notGranted')}
              </div></div>
            <button type="button" className="button secondary compact shrink-0 disabled:opacity-50" disabled={busy || !status.available} onClick={() => { void run(() => bridge.requestPermission(permission)); }}>
              {t('computerUse.openPermissions')}
            </button>
          </div>;
        }) : <p className="computer-use-note">
          {t(!status ? 'computerUse.checking' : status.platform === 'win32' ? 'computerUse.windowsPermissions' : 'computerUse.linuxPermissions')}
        </p>}
      {status?.platform === 'darwin' && <p className="computer-use-note">{t('computerUse.permissionHint', { owner: permissionOwner })}</p>}
      {status?.platform === 'darwin' && status.permissionAppPath && <details
        open={status.permissions && (status.permissions.accessibility === false || status.permissions.screenRecording === false) ? true : undefined}
        className="computer-use-fallback text-xs leading-5">
        <summary className="cursor-pointer font-medium">{t('computerUse.permissionFallbackTitle')}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-muted-foreground">{t('computerUse.permissionFallbackIntro', { owner: permissionOwner })}</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>{t('computerUse.permissionFallbackAdd')}</li>
            <li>{t('computerUse.permissionFallbackSelect')}</li>
            <li>{t('computerUse.permissionFallbackFinish')}</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="button secondary compact disabled:opacity-50" disabled={busy || !status.available}
              onClick={() => { void run(() => bridge.revealPermissionApp()); }}>{t('computerUse.revealPermissionApp')}</button>
            <button type="button" className="button secondary compact disabled:opacity-50" disabled={busy}
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
      </article>
    </section>

    <section className="general-section">
      <article className="general-card">
        <GeneralCardHeader icon={<GeneralSettingsIcon icon={Activity} />} title={t('computerUse.statusTitle')} />
        <div className="general-setting-row computer-use-status-row">
          <div className="general-setting-copy" role="status" aria-live="polite">
            <strong className="general-setting-title">{status ? t(`computerUse.phases.${status.phase}`) : t('computerUse.checking')}</strong>
            {status && <p>{t('computerUse.version', { version: status.version })}
              {status.desktopSession ? ` · ${status.desktopSession === 'x11' ? 'X11' : status.desktopSession === 'wayland' ? 'Wayland' : t('computerUse.unknownSession')}` : ''}</p>}
          </div>
          <div className="computer-use-actions">
            <button type="button" className="button secondary compact disabled:opacity-50" disabled={busy || !status} onClick={() => { void run(() => bridge.refresh()); }}>
              <GeneralSettingsIcon icon={RefreshCw} className={busy ? 'animate-spin' : ''} />{t('computerUse.refresh')}
            </button>
            {status?.enabled && <button type="button" className="button secondary compact disabled:opacity-50" disabled={busy} onClick={() => { void run(() => bridge.setEnabled(false)); }}>
              <GeneralSettingsIcon icon={Square} />{t('computerUse.stop')}
            </button>}
          </div>
        </div>
        {status?.phase === 'partial' && <p className="computer-use-note">{t('computerUse.waylandHint')}</p>}
        {(error || loadError || status?.error) && <p role="alert" className="computer-use-note">{error || loadError || status?.error}</p>}
        {status && !status.available && <p role="alert" className="computer-use-note">{t('computerUse.missingDriver')}</p>}
      </article>
    </section>
  </div>;
}
