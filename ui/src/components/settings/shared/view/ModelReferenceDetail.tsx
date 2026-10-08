import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { PilotDeckConfig } from '../../view/modelPool/types';
import { buildModelRefOptions, ensureModelRefConfigured } from '../../view/modelPool/utils/modelRefs';
import { patch } from '../../view/modelPool/utils/patch';
import { usageLabel } from '../../view/modelPool/utils/modelUsage';
import { GeneralSelectControl, GeneralSettingRow } from './GeneralSettingsPrimitives';
import ConfigSaveError from './ConfigSaveError';
import { isOptionalFeatureEnabled } from '../../../../../../src/pilot/config/optionalFeature.js';

// Pricing keys can contain both dots and slashes. Never split a model ID.
export function modelReferencePath(reference: string): Array<string | number> | null {
  if (reference === 'agent.subagents.default' || reference === 'router.tokenSaver.judge' || reference === 'router.stats.baselineModel') return reference.split('.');
  const pricing = /^router\.stats\.modelPricing\.(.+)$/.exec(reference);
  if (pricing) return ['router', 'stats', 'modelPricing', pricing[1]];
  const scenario = /^router\.scenarios\.([^.]+)$/.exec(reference);
  if (scenario) return ['router', 'scenarios', scenario[1]];
  const fallback = /^router\.fallback\.([^.]+)\.(\d+)$/.exec(reference);
  if (fallback) return ['router', 'fallback', fallback[1], Number(fallback[2])];
  const tier = /^router\.tokenSaver\.tiers\.([^.]+)\.model$/.exec(reference);
  return tier ? ['router', 'tokenSaver', 'tiers', tier[1], 'model'] : null;
}

export default function ModelReferenceDetail({ config, reference, onChange }: {
  config: PilotDeckConfig; reference?: string | null; onChange: (config: PilotDeckConfig) => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = reference && modelReferencePath(reference);
  if (!reference || !path) return null;
  const routerEnabled = isOptionalFeatureEnabled(config.router);
  // Focus an existing modern editor whenever it is visible. The detail card
  // supplies only settings that the current route layout otherwise conceals.
  if ((reference === 'agent.subagents.default' && (!routerEnabled || config.router?.tokenSaver?.subagent?.policy === 'skip'))
    || (routerEnabled && (reference === 'router.tokenSaver.judge'
      || reference.startsWith('router.stats.modelPricing.')
      || (path[1] === 'tokenSaver' && path[2] === 'tiers' && config.router?.tokenSaver?.tiers?.[path[3]])))) return null;
  const value = path.reduce<unknown>((current, key) => current && typeof current === 'object'
    ? (current as Record<string, unknown>)[key] : undefined, config);
  const objectRef = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const model = typeof value === 'string' ? value
    : typeof objectRef?.id === 'string' ? objectRef.id
    : typeof objectRef?.provider === 'string' && typeof objectRef.model === 'string' ? `${objectRef.provider}/${objectRef.model}` : '';
  const options = buildModelRefOptions(config);
  if (model && !options.some(option => option.value === model)) options.unshift({ value: model, label: model });
  if (reference === 'agent.subagents.default' && !options.some(option => option.value === 'inherit')) options.unshift({ value: 'inherit', label: t('pilotDeckConfig.panels.router.ui.inheritMainModel') });
  const pricing = path[2] === 'modelPricing';
  return <section className="general-card model-reference-detail" data-model-reference={reference} tabIndex={-1}>
    <GeneralSettingRow title={usageLabel(reference, t)} detail={reference}>
      {model ? <GeneralSelectControl value={model} options={options} disabled={saving} ariaLabel={usageLabel(reference, t)} onChange={async next => {
        let replacement: unknown = next;
        if (objectRef) {
          replacement = { ...objectRef, ...(typeof objectRef.id === 'string' ? { id: next } : {}) };
          if ('provider' in objectRef || 'model' in objectRef) {
            const slash = next.indexOf('/');
            replacement = { ...replacement as object, provider: next.slice(0, slash), model: next.slice(slash + 1) };
          }
        }
        setSaving(true);
        setError(null);
        try {
          let updated = patch(ensureModelRefConfigured(config, next), path, replacement);
          // The server and gateway derive the default route from agent.model.
          // Save both together so normalization does not undo this selection.
          if (reference === 'router.scenarios.default') updated = patch(updated, ['agent', 'model'], next);
          await onChange(updated);
        }
        catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setSaving(false); }
      }} /> : pricing && objectRef ? <dl className="model-reference-pricing">
        {(['input', 'output', 'cacheRead'] as const).map(field => <div key={field}>
          <dt>{t(`pilotDeckConfig.panels.router.ui.${field === 'input' ? 'pricingInput' : field === 'output' ? 'pricingOutput' : 'pricingCache'}`)}</dt>
          <dd>{String(objectRef[field] ?? '—')}</dd>
        </div>)}
      </dl> : <span className="model-reference-value">{value === undefined ? '—' : JSON.stringify(value)}</span>}
    </GeneralSettingRow>
    <ConfigSaveError error={error} />
  </section>;
}
