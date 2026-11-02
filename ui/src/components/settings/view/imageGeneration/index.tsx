import { useEffect, useMemo, useState } from 'react';
import { Image, KeyRound, Link, Pencil, Plug, Save, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePilotDeckConfig } from '../../../../hooks/usePilotDeckConfig';
import { authenticatedFetch } from '../../../../utils/api';
import { ConfigSaveError, SettingsToggle } from '../../shared/view';
import { GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';
import { configToYamlString, safeParseYaml } from '../modelPool/utils/configYaml';
import type { PilotDeckConfig } from '../modelPool/types';
import { DEFAULT_IMAGE_BASE_URL } from '../../../../../../src/pilot/config/imageGenerationConfig.js';

export function ImageGenerationForm({ config, onChange }: { config: PilotDeckConfig; onChange: (config: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const current = config.tools?.imageGeneration ?? {};
  const [draft, setDraft] = useState({ ...current, baseUrl: current.baseUrl || DEFAULT_IMAGE_BASE_URL });
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => { if (!editing) setDraft({ ...current, baseUrl: current.baseUrl || DEFAULT_IMAGE_BASE_URL }); }, [current.apiKey, current.baseUrl, current.model, current.enabled, editing]);
  const commit = (value: typeof current) => onChange({ ...config, tools: { ...config.tools, imageGeneration: value } });
  const ready = Boolean(current.apiKey?.trim() && current.model?.trim());
  const check = async () => {
    setChecking(true); setStatus('');
    try {
      const response = await authenticatedFetch('/api/image-generation/test', { method: 'POST', body: JSON.stringify(current) });
      const body = await response.json();
      setStatus(body.ok ? t('imageGeneration.connected') : t('imageGeneration.connectionFailed'));
    } catch { setStatus(t('imageGeneration.connectionFailed')); }
    finally { setChecking(false); }
  };
  return <>
    <section className="route-card route-enable-card search-enable-card">
      <div className="route-card-heading"><span className="route-heading-icon"><GeneralSettingsIcon icon={Image} /></span><div><h2>{t('imageGeneration.enabled')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('imageGeneration.defaultOff')}</p></div></div>
      <SettingsToggle checked={current.enabled === true} ariaLabel={t('imageGeneration.enabled')} disabled={!ready && current.enabled !== true}
        onChange={value => { commit({ ...current, enabled: value }); setStatus(''); }} suppressNextSaveToast />
    </section>
    <section className="search-card" aria-label={t('settingsPage.menu.imageGeneration')}>
      <div className="search-config-body">
        {(['apiKey', 'baseUrl', 'model'] as const).map(field => <div className="search-setting-row" key={field}>
          <div className="search-setting-copy"><label htmlFor={`image-${field}`}>{t(`imageGeneration.${field}`)}</label><p>{t(`imageGeneration.${field}Hint`)}</p></div>
          <div className="search-control-area"><div className="search-input-wrap">
            <GeneralSettingsIcon icon={field === 'apiKey' ? KeyRound : field === 'baseUrl' ? Link : Image} />
            <input id={`image-${field}`} type={field === 'apiKey' ? 'password' : 'text'} autoComplete="off" spellCheck={false} disabled={!editing}
              value={draft[field] ?? ''} placeholder={field === 'baseUrl' ? DEFAULT_IMAGE_BASE_URL : ''}
              onChange={event => { setDraft({ ...draft, [field]: event.target.value }); setStatus(''); }} />
          </div></div>
        </div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-5">
        <span role="status" className="text-sm text-muted-foreground">{status}</span>
        <div className="flex gap-2">
          {editing ? <>
            <button className="button secondary compact" type="button" onClick={() => setEditing(false)}><GeneralSettingsIcon icon={X} />{t('settingsPage.actions.cancel')}</button>
            <button className="button primary compact" type="button" disabled={current.enabled === true && ((!draft.apiKey?.trim() && (!current.apiKey || draft.baseUrl !== (current.baseUrl || DEFAULT_IMAGE_BASE_URL))) || !draft.model?.trim())}
              onClick={() => { commit({ ...draft, apiKey: draft.apiKey?.trim() || ((draft.baseUrl || DEFAULT_IMAGE_BASE_URL) === (current.baseUrl || DEFAULT_IMAGE_BASE_URL) ? current.apiKey : undefined), model: draft.model?.trim(), baseUrl: draft.baseUrl?.trim() || DEFAULT_IMAGE_BASE_URL, enabled: current.enabled === true }); setEditing(false); }}><GeneralSettingsIcon icon={Save} />{t('settingsPage.actions.save')}</button>
          </> : <>
            <button className="button secondary compact" type="button" onClick={() => { setDraft({ ...current, baseUrl: current.baseUrl || DEFAULT_IMAGE_BASE_URL, apiKey: current.apiKey === '********' ? '' : current.apiKey }); setEditing(true); }}><GeneralSettingsIcon icon={Pencil} />{t('settingsPage.actions.edit')}</button>
            <button className="button secondary compact" type="button" disabled={checking || !current.apiKey} onClick={() => void check()}><GeneralSettingsIcon icon={Plug} />{t(checking ? 'imageGeneration.checking' : 'imageGeneration.check')}</button>
          </>}
        </div>
      </div>
    </section>
  </>;
}

export default function ImageGenerationSettings() {
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const config = useMemo(() => safeParseYaml(raw), [raw]);
  const { t } = useTranslation('settings');
  if (loading) return <div role="status">{t('pilotDeckConfig.loading')}</div>;
  if (!config) return <div>{t('settingsPage.invalidYaml.agentSearch')}</div>;
  return <div className="search-page-content"><ConfigSaveError error={error} /><ImageGenerationForm config={config} onChange={next => void commitRaw(configToYamlString(next))} /></div>;
}
