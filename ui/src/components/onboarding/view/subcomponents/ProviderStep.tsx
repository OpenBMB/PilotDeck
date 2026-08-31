import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CATALOG_PROVIDERS,
  findCatalogProviderById,
  type CatalogProvider,
} from '../../../../shared/catalogProviders';
import { authenticatedFetch } from '../../../../utils/api';
import { CUSTOM_PROVIDER, PROVIDER_LOGOS } from '../constants';
import type { LlmSetupController } from '../types';
import FooterActions from './FooterActions';
import { GearIcon, RadioCheckIcon } from './icons';

type ProviderStepProps = {
  llm: LlmSetupController;
  onBack: () => void;
  onContinue: () => void;
};

type ProviderListItem = {
  id: string;
  displayName: string;
  protocol?: CatalogProvider['protocol'];
  endpoint?: string;
  logoUrl?: string;
  requiresApiKey?: boolean;
};

function fallbackProviders(): ProviderListItem[] {
  return CATALOG_PROVIDERS.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    protocol: provider.protocol,
    endpoint: provider.defaultUrl,
    logoUrl: PROVIDER_LOGOS[provider.id],
    requiresApiKey: provider.requiresApiKey !== false,
  }));
}

function toCatalogProvider(item: ProviderListItem): CatalogProvider {
  return findCatalogProviderById(item.id) ?? {
    id: item.id,
    displayName: item.displayName,
    protocol: item.protocol ?? 'openai',
    defaultUrl: item.endpoint ?? '',
    models: [],
    requiresApiKey: item.requiresApiKey,
  };
}

function providerInitials(name: string) {
  const ascii = name.replace(/[^\w\s]/g, ' ').trim();
  const parts = ascii.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function ProviderStep({ llm, onBack, onContinue }: ProviderStepProps) {
  const { t } = useTranslation('onboarding');
  const [providers, setProviders] = useState<ProviderListItem[]>(fallbackProviders);

  useEffect(() => {
    const abortController = new AbortController();
    authenticatedFetch('/api/v1/providers', { signal: abortController.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        const items = Array.isArray(data?.providers) ? data.providers : [];
        const next = items.flatMap((item: unknown): ProviderListItem[] => {
          if (!item || typeof item !== 'object') return [];
          const candidate = item as ProviderListItem;
          if (typeof candidate.id !== 'string' || typeof candidate.displayName !== 'string') return [];
          return [{
            ...candidate,
            logoUrl: typeof candidate.logoUrl === 'string' && candidate.logoUrl
              ? candidate.logoUrl
              : PROVIDER_LOGOS[candidate.id],
          }];
        });
        if (next.length > 0) setProviders(next);
      })
      .catch(() => {
        /* Keep the local catalog fallback if the onboarding provider list is unavailable. */
      });
    return () => abortController.abort();
  }, []);

  return (
    <div className="content-page">
      <header className="page-intro">
        <h1>{t('provider.title')}</h1>
        <p className="intro-copy">{t('provider.intro')}</p>
      </header>

      <div className="provider-grid">
        <button
          className={`provider-card custom-provider${llm.isCustomMode ? ' selected' : ''}`}
          type="button"
          aria-pressed={llm.isCustomMode}
          aria-label={t('provider.customTitle')}
          onClick={() => llm.handleProviderSelect(CUSTOM_PROVIDER)}
        >
          <span className="provider-icon" aria-hidden="true">
            <GearIcon width={22} height={22} />
          </span>
          <span className="provider-copy">
            <span className="provider-title-row">
              <strong>{t('provider.customTitle')}</strong>
            </span>
          </span>
          <span className="radio-dot" aria-hidden="true">
            {llm.isCustomMode && <RadioCheckIcon />}
          </span>
        </button>
        {providers.map((provider) => {
          const selected = llm.selectedProvider?.id === provider.id;
          return (
            <button
              key={provider.id}
              className={`provider-card${selected ? ' selected' : ''}`}
              type="button"
              aria-pressed={selected}
              aria-label={provider.displayName}
              onClick={() => llm.handleProviderSelect(toCatalogProvider(provider))}
            >
              <span className="provider-icon" aria-hidden="true">
                {provider.logoUrl ? (
                  <img src={provider.logoUrl} alt="" />
                ) : (
                  providerInitials(provider.displayName)
                )}
              </span>
              <span className="provider-copy">
                <span className="provider-title-row">
                  <strong>{provider.displayName}</strong>
                </span>
              </span>
              <span className="radio-dot" aria-hidden="true">
                {selected && <RadioCheckIcon />}
              </span>
            </button>
          );
        })}
      </div>

      <FooterActions
        backLabel={t('actions.back')}
        nextLabel={t('actions.next')}
        nextDisabled={!llm.selectedProvider}
        onBack={onBack}
        onNext={onContinue}
      />
    </div>
  );
}
