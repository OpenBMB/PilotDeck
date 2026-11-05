import { useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Image, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePilotDeckConfig } from '../../../../hooks/usePilotDeckConfig';
import { ConfigSaveError } from '../../shared/view';
import { getMultimodalGenerationTab, type MultimodalGenerationTab } from '../../navigation';
import { ImageGenerationForm } from '../imageGeneration';
import { VideoGenerationForm } from '../videoGeneration';
import { configToYamlString, safeParseYaml } from '../modelPool/utils/configYaml';
import type { PilotDeckConfig } from '../modelPool/types';

const modalities = [
  { tab: 'image', key: 'imageGeneration', Icon: Image, Form: ImageGenerationForm },
  { tab: 'video', key: 'videoGeneration', Icon: Video, Form: VideoGenerationForm },
] as const;

export default function MultimodalGenerationSettings() {
  const { raw, commitRaw, loading, saving, error } = usePilotDeckConfig();
  const config = useMemo(() => safeParseYaml(raw), [raw]);
  const latestConfig = useRef(config);
  latestConfig.current = config;
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const active = getMultimodalGenerationTab(pathname.split('/').pop(), params.get('tab'));
  const select = (tab: MultimodalGenerationTab) => {
    const next = new URLSearchParams(params);
    if (tab === 'image') next.delete('tab'); else next.set('tab', tab);
    setParams(next, { replace: true });
  };
  if (loading) return <div role="status">{t('pilotDeckConfig.loading')}</div>;
  if (!config) return <div>{t('settingsPage.invalidYaml.agentSearch')}</div>;

  // Each form owns its draft. Save only its namespace against the latest
  // shared snapshot so a sibling's settings never come from a stale closure.
  const commit = (key: typeof modalities[number]['key'], next: PilotDeckConfig) => {
    const base = latestConfig.current!;
    const merged = { ...base, tools: { ...base.tools, [key]: next.tools?.[key] } };
    latestConfig.current = merged;
    return commitRaw(configToYamlString(merged));
  };

  return <div className="search-page-content multimodal-generation-content">
    <ConfigSaveError error={error} />
    <div className="multimodal-tabs" role="tablist" aria-label={t('multimodalGeneration.tabsLabel')}>
      {modalities.map(({ tab, key, Icon }, index) => {
        const enabled = config.tools?.[key]?.enabled === true;
        return <button key={tab} type="button" role="tab" id={`generation-tab-${tab}`}
          aria-controls={`generation-panel-${tab}`} aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
          className="multimodal-tab" onClick={() => select(tab)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? modalities.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + modalities.length) % modalities.length;
            select(modalities[next].tab);
            document.getElementById(`generation-tab-${modalities[next].tab}`)?.focus();
          }}>
          <Icon size={17} aria-hidden="true" />{t(`multimodalGeneration.${tab}`)}
          <span className={`multimodal-state-dot${enabled ? ' is-enabled' : ''}`} role="img"
            aria-label={t(enabled ? 'multimodalGeneration.enabled' : 'multimodalGeneration.disabled')} />
        </button>;
      })}
    </div>
    <fieldset className="multimodal-panels" disabled={saving} aria-busy={saving}>
      {modalities.map(({ tab, key, Form }) => <div key={tab} id={`generation-panel-${tab}`} role="tabpanel"
        aria-labelledby={`generation-tab-${tab}`} hidden={active !== tab}>
        <Form config={config} onChange={next => commit(key, next)} />
      </div>)}
    </fieldset>
  </div>;
}
