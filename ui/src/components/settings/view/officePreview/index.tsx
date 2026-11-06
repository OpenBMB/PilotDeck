import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, RefreshCw, Settings2 } from 'lucide-react';
import { usePilotDeckConfig, type ConfigSaveResult } from '../../../../hooks/usePilotDeckConfig';
import { cn } from '../../../../lib/utils';
import { normalizeOfficePreviewService, officeBinaryPathExample, readOfficePreviewStatus,
  type OfficePreviewService, type OfficePreviewStatus } from '../../../../utils/officePreviewStatus';
import { ConfigSaveError } from '../../shared/view';
import { GeneralCardHeader, GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';
import type { PilotDeckConfig } from '../modelPool/types';
import { configToYamlString, safeParseYaml } from '../modelPool/utils/configYaml';
import { patch } from '../modelPool/utils/patch';

function OfficePreviewSection({ config, onChange, saving }: {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => Promise<ConfigSaveResult>;
  saving: boolean;
}) {
  const { t } = useTranslation('settings');
  const key = 'pilotDeckConfig.panels.officePreview';
  const [status, setStatus] = useState<OfficePreviewStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusReloadKey, setStatusReloadKey] = useState(0);
  const [pathEdited, setPathEdited] = useState(false);
  const [checking, setChecking] = useState(false);
  const operationPending = useRef(false);
  const service = normalizeOfficePreviewService(config.webui?.officePreview?.service);
  const configuredBinaryPath = config.webui?.officePreview?.binaryPath ?? '';
  const [binaryPathDraft, setBinaryPathDraft] = useState(configuredBinaryPath);

  useEffect(() => {
    if (!pathEdited && !checking) setBinaryPathDraft(configuredBinaryPath);
  }, [configuredBinaryPath, pathEdited, checking]);

  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    setStatusError('');
    readOfficePreviewStatus({ refresh: statusReloadKey > 0 })
      .then(body => {
        if (cancelled) return;
        setStatus(body);
        setStatusError(body.statusError || '');
      })
      .catch((error: Error) => {
        if (!cancelled) setStatusError(error.message || t(`${key}.status.error`));
      })
      .finally(() => { if (!cancelled) setStatusLoading(false); });
    return () => { cancelled = true; };
  }, [statusReloadKey, t]);

  const busy = saving || checking || statusLoading;
  const checkPath = async () => {
    if (busy || operationPending.current) return;
    operationPending.current = true;
    setChecking(true);
    try {
      if (pathEdited) {
        const result = await onChange(patch(config, ['webui', 'officePreview', 'binaryPath'], binaryPathDraft.trim()));
        // Do not scan an old path, or discard the draft, after a rejected write.
        if (!result.ok) return;
        setPathEdited(false);
      }
      setStatusLoading(true);
      setStatusReloadKey(value => value + 1);
    } finally {
      operationPending.current = false;
      setChecking(false);
    }
  };
  const cancelPath = () => { setBinaryPathDraft(configuredBinaryPath); setPathEdited(false); };
  const setService = (next: OfficePreviewService) => {
    void onChange(patch(config, ['webui', 'officePreview', 'service'], next));
  };
  const statusMatchesPath = status?.configuredBinaryPath === configuredBinaryPath;
  const available = statusMatchesPath && status?.libreOffice?.available === true;
  const unavailable = statusMatchesPath && !busy && !pathEdited && status?.libreOffice?.available === false;
  const statusKey = pathEdited ? 'pending' : busy ? 'checking' : statusError ? 'error'
    : available ? 'available' : unavailable ? 'unavailable' : 'unknown';

  return <>
    <section className="general-section">
      <article className="general-card">
        <GeneralCardHeader icon={<GeneralSettingsIcon icon={FileText} />} title={t(`${key}.fields.service.label`)} />
        <fieldset className="office-service-choices" disabled={saving || checking}>
          <legend className="sr-only">{t(`${key}.fields.service.label`)}</legend>
          <div className="office-service-grid">
            {(['builtin', 'libreoffice'] as const).map(option => (
              <label key={option} className="office-service-choice" data-selected={service === option}>
                <input type="radio" name="office-preview-service" value={option} checked={service === option}
                  onChange={() => setService(option)} aria-label={t(`${key}.options.${option === 'builtin' ? 'builtin' : 'libreOffice'}`)}
                  aria-describedby={`office-service-${option}-description`} />
                <span>
                  <strong>{t(`${key}.options.${option === 'builtin' ? 'builtin' : 'libreOffice'}`)}</strong>
                  <span id={`office-service-${option}-description`} className="office-service-description">{t(`${key}.serviceDetails.${option}`)}</span>
                </span>
              </label>
            ))}
          </div>
          {service === 'builtin' && <p className="office-builtin-note">{t(`${key}.builtinNote`)}</p>}
        </fieldset>
      </article>
    </section>
    {service === 'libreoffice' && <section className="general-section">
      <article className="general-card office-path-card">
        <GeneralCardHeader icon={<GeneralSettingsIcon icon={Settings2} />} title={t(`${key}.configurationTitle`)} />
        <div className="office-path-body">
          <div className="general-setting-copy">
            <label className="general-setting-title" htmlFor="office-binary-path">{t(`${key}.fields.binaryPath.label`)}</label>
            <p id="office-path-help">{t(`${key}.fields.binaryPath.description`)}</p>
          </div>
          <div className="office-path-input">
            <input id="office-binary-path" value={binaryPathDraft} spellCheck={false} disabled={saving || checking}
              placeholder={officeBinaryPathExample(status?.platform) ?? t(`${key}.fields.binaryPath.placeholder`)}
              aria-describedby="office-path-help"
              onChange={event => { setBinaryPathDraft(event.target.value); setPathEdited(true); }}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') { event.preventDefault(); void checkPath(); }
                if (event.key === 'Escape') { event.preventDefault(); cancelPath(); }
              }} />
          </div>
          <div className="office-path-actions">
            {pathEdited && <button type="button" className="button secondary compact" disabled={busy} onClick={cancelPath}>
              {t('settingsPage.actions.cancel')}
            </button>}
            <button type="button" className={cn('button compact', pathEdited ? 'primary' : 'secondary')}
              disabled={busy} onClick={() => { void checkPath(); }}>
              <GeneralSettingsIcon icon={RefreshCw} className={busy ? 'animate-spin' : ''} />
              {t(`${key}.status.${busy ? 'checking' : pathEdited ? 'saveAndCheck' : 'refresh'}`)}
            </button>
          </div>
          <div className={cn('office-status-panel', statusKey === 'available' && 'available')} aria-busy={busy}>
            <div className="office-status-heading" role="status" aria-live="polite">
              <div><span className={cn('office-status-dot', busy && 'checking')} aria-hidden="true" />
                <strong>{t(`${key}.status.${statusKey}`)}</strong>
              </div>
            </div>
            {!pathEdited && !busy && !statusError && available && <div className="office-status-detail">
              {(['binaryPath', 'version'] as const).map(field => status?.libreOffice?.[field] && <p key={field}>
                <span>{t(`${key}.status.${field === 'binaryPath' ? 'pathLabel' : 'versionLabel'}`)}</span>
                <code>{status.libreOffice[field]}</code>
              </p>)}
            </div>}
            {unavailable && <p className="office-status-note">{t(`${key}.unavailableWarning`)}</p>}
            {statusError && <p role="alert" className="office-status-note">{statusError}</p>}
          </div>
        </div>
      </article>
    </section>}
  </>;
}

export default function OfficePreviewSections({ title: _title }: { title: string }) {
  const { t } = useTranslation('settings');
  const { confirmedRaw, commitRaw, loading, saving, error } = usePilotDeckConfig();
  const [serializationError, setSerializationError] = useState('');
  const parsedConfig = useMemo(() => safeParseYaml(confirmedRaw), [confirmedRaw]);
  const onFormChange = async (next: PilotDeckConfig): Promise<ConfigSaveResult> => {
    setSerializationError('');
    try { return await commitRaw(configToYamlString(next)); }
    catch (caught) {
      const message = caught instanceof Error ? caught.message : t('settingsPage.invalidYaml.officePreview');
      setSerializationError(message);
      return { ok: false, error: message };
    }
  };
  if (loading) return <div role="status" className="py-6 text-xs text-muted-foreground">{t('pilotDeckConfig.loading')}</div>;
  if (!parsedConfig) return <ConfigSaveError error={t('settingsPage.invalidYaml.officePreview')} />;
  return <div className="general-page-content office-page-content">
    <ConfigSaveError error={serializationError || error} />
    <OfficePreviewSection config={parsedConfig} onChange={onFormChange} saving={saving} />
  </div>;
}
