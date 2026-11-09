import { useEffect, useMemo, useRef, useState } from 'react';
import { Video, KeyRound, Link, Plug, Save, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePilotDeckConfig, type ConfigSaveResult } from '../../../../hooks/usePilotDeckConfig';
import { authenticatedFetch } from '../../../../utils/api';
import { ConfigSaveError, SettingsToggle } from '../../shared/view';
import { GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';
import { configToYamlString, safeParseYaml } from '../modelPool/utils/configYaml';
import type { PilotDeckConfig } from '../modelPool/types';
import { DEFAULT_VIDEO_BASE_URL, videoApiBaseUrl, type VideoGenerationConfig } from '../../../../../../src/pilot/config/videoGenerationConfig.js';

type Field = 'apiKey' | 'baseUrl' | 'model';
type Draft = Record<Field, string> & { extraParams: string };
const fields: Field[] = ['apiKey', 'baseUrl', 'model'];
const draftOf = (config: VideoGenerationConfig): Draft => ({
  apiKey: '', baseUrl: config.baseUrl || DEFAULT_VIDEO_BASE_URL, model: config.model || '', extraParams: JSON.stringify(config.extraParams ?? {}, null, 2),
});
function address(value?: string) {
  try { return videoApiBaseUrl(value); } catch { return value?.trim(); }
}

export function VideoGenerationForm({ config, onChange }: {
  config: PilotDeckConfig;
  onChange: (config: PilotDeckConfig) => void | Promise<ConfigSaveResult>;
}) {
  const { t } = useTranslation('settings');
  const current = config.tools?.videoGeneration ?? {};
  const [draft, setDraft] = useState(() => draftOf(current));
  const [errors, setErrors] = useState<Partial<Record<Field | 'extraParams', string>>>({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const probe = useRef<AbortController | null>(null);
  const resetTest = () => {
    probe.current?.abort(); probe.current = null;
    setChecking(false); setStatus('');
  };
  useEffect(() => {
    setDraft(draftOf(current)); setErrors({}); resetTest();
  }, [current.apiKey, current.baseUrl, current.model, JSON.stringify(current.extraParams)]);
  useEffect(() => () => { probe.current?.abort(); }, []);

  const sameAddress = address(draft.baseUrl) === address(current.baseUrl);
  const dirty = Boolean(draft.apiKey.trim()) || !sameAddress || draft.model.trim() !== (current.model || '').trim() || draft.extraParams !== JSON.stringify(current.extraParams ?? {}, null, 2);
  const validate = (credentialsRequired: boolean): VideoGenerationConfig | null => {
    const nextErrors: Partial<Record<Field | 'extraParams', string>> = {};
    let baseUrl = draft.baseUrl.trim() || DEFAULT_VIDEO_BASE_URL;
    try { baseUrl = videoApiBaseUrl(baseUrl); } catch { nextErrors.baseUrl = 'videoGeneration.invalidAddress'; }
    const apiKey = draft.apiKey.trim() || (sameAddress ? current.apiKey : undefined);
    const model = draft.model.trim();
    if (credentialsRequired) {
      if (!apiKey || (!sameAddress && apiKey === '********')) nextErrors.apiKey = sameAddress ? 'videoGeneration.keyRequired' : 'videoGeneration.newKeyRequired';
      if (!model) nextErrors.model = 'videoGeneration.modelRequired';
    }
    let extraParams: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(draft.extraParams || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || draft.extraParams.length > 8192) throw new Error();
      extraParams = parsed;
    } catch { nextErrors.extraParams = 'videoGeneration.invalidParams'; }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      document.getElementById('video-' + [...fields, 'extraParams' as const].find(field => nextErrors[field]))?.focus();
      return null;
    }
    return { ...current, apiKey, baseUrl, model, ...(Object.keys(extraParams).length ? { extraParams } : { extraParams: undefined }) };
  };
  const commit = async (value: VideoGenerationConfig, resetDraft = false) => {
    resetTest(); setSaving(true);
    try {
      const result = await onChange({ ...config, tools: { ...config.tools, videoGeneration: value } });
      if (result && !result.ok) setStatus(result.error);
      else if (resetDraft) { setDraft(draftOf(value)); setErrors({}); }
    }
    catch { setStatus(t('videoGeneration.saveFailed')); }
    finally { setSaving(false); }
  };
  const save = () => {
    const value = validate(current.enabled === true);
    if (value) void commit(value, true);
  };
  const toggle = (enabled: boolean) => {
    // Turning off must also work with incomplete, unsaved form fields.
    const value = enabled ? validate(true) : current;
    if (value) void commit({ ...value, enabled });
  };
  const check = async () => {
    resetTest();
    const value = validate(true);
    if (!value) return;
    const controller = new AbortController();
    probe.current = controller;
    setChecking(true);
    try {
      const response = await authenticatedFetch('/api/video-generation/test', {
        method: 'POST', body: JSON.stringify(value), signal: controller.signal, suppressServerErrorToast: true,
      });
      const body = await response.json();
      if (probe.current !== controller) return;
      setStatus(response.ok && body.ok
        ? t('videoGeneration.connected', { seconds: (body.latencyMs / 1000).toFixed(1) })
        : t('videoGeneration.connectionFailed', { error: body.error || t('videoGeneration.unknownError') }));
    } catch (error) {
      if (probe.current === controller) setStatus(t('videoGeneration.connectionFailed', {
        error: error instanceof Error ? error.message : t('videoGeneration.unknownError'),
      }));
    } finally {
      if (probe.current === controller) { probe.current = null; setChecking(false); }
    }
  };
  return <>
    <section className="route-card route-enable-card search-enable-card">
      <div className="route-card-heading"><span className="route-heading-icon"><GeneralSettingsIcon icon={Video} /></span><h2>{t('videoGeneration.enabled')}</h2></div>
      <SettingsToggle checked={current.enabled === true} ariaLabel={t('videoGeneration.enabled')} disabled={saving}
        onChange={toggle} suppressNextSaveToast />
    </section>
    <section className="search-card" aria-label={t('settingsPage.menu.videoGeneration')}>
      <div className="search-config-body">
        {fields.map(field => <div className="search-setting-row" key={field}>
          <div className="search-setting-copy"><label htmlFor={'video-' + field}>{t('videoGeneration.' + field)}</label></div>
          <div className="search-control-area"><div className="search-input-wrap">
            <GeneralSettingsIcon icon={field === 'apiKey' ? KeyRound : field === 'baseUrl' ? Link : Video} />
            <input id={'video-' + field} type={field === 'apiKey' ? 'password' : 'text'} autoComplete="off" spellCheck={false} disabled={saving}
              aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? 'video-' + field + '-error' : undefined}
              value={draft[field]} placeholder={field === 'apiKey' && current.apiKey && sameAddress ? '********' : field === 'baseUrl' ? DEFAULT_VIDEO_BASE_URL : ''}
              onChange={event => { setDraft({ ...draft, [field]: event.target.value }); setErrors(previous => ({ ...previous, [field]: undefined })); resetTest(); }}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && dirty) save(); }} />
          </div>{errors[field] && <p id={'video-' + field + '-error'} role="alert" className="mt-1 text-sm text-[var(--pd-danger-ink)]">{t(errors[field]!)}</p>}</div>
        </div>)}
      </div>
      <details className="border-t border-border p-5">
        <summary className="cursor-pointer text-sm font-medium">{t('videoGeneration.extraParams')}</summary>
        <p className="my-2 text-sm text-muted-foreground">{t('videoGeneration.extraParamsHint')}</p>
        <label htmlFor="video-extraParams" className="sr-only">{t('videoGeneration.extraParams')}</label>
        <textarea id="video-extraParams" rows={4} value={draft.extraParams} disabled={saving} spellCheck={false}
          aria-invalid={Boolean(errors.extraParams)} className="w-full rounded-lg border border-border bg-background p-3 font-mono text-sm"
          onChange={event => { setDraft({ ...draft, extraParams: event.target.value }); setErrors(previous => ({ ...previous, extraParams: undefined })); resetTest(); }} />
        {errors.extraParams && <p role="alert" className="mt-1 text-sm text-[var(--pd-danger-ink)]">{t(errors.extraParams)}</p>}
      </details>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-5">
        <span role="status" className="text-sm text-muted-foreground">{status}</span>
        <div className="flex gap-2">
          <button className="button secondary compact" type="button" disabled={checking || saving} onClick={() => void check()}><GeneralSettingsIcon icon={Plug} />{t(checking ? 'videoGeneration.checking' : 'videoGeneration.check')}</button>
          {dirty && <button className="button secondary compact" type="button" disabled={saving} onClick={() => { setDraft(draftOf(current)); setErrors({}); resetTest(); }}><GeneralSettingsIcon icon={X} />{t('settingsPage.actions.cancel')}</button>}
          <button className="button primary compact" type="button" disabled={saving || !dirty} onClick={save}><GeneralSettingsIcon icon={Save} />{t('settingsPage.actions.save')}</button>
        </div>
      </div>
    </section>
  </>;
}

export default function VideoGenerationSettings() {
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const config = useMemo(() => safeParseYaml(raw), [raw]);
  const { t } = useTranslation('settings');
  if (loading) return <div role="status">{t('pilotDeckConfig.loading')}</div>;
  if (!config) return <div>{t('settingsPage.invalidYaml.agentSearch')}</div>;
  return <div className="search-page-content"><ConfigSaveError error={error} /><VideoGenerationForm config={config} onChange={next => commitRaw(configToYamlString(next))} /></div>;
}
