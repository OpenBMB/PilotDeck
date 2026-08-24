import { useTranslation } from 'react-i18next';
import { CATALOG_PROVIDERS } from '../../../../shared/catalogProviders';
import { CUSTOM_PROVIDER } from '../constants';
import type { LlmSetupController } from '../types';
import FooterActions from './FooterActions';
import { RadioCheckIcon } from './icons';

type ProviderStepProps = {
  llm: LlmSetupController;
  onBack: () => void;
  onContinue: () => void;
};

function providerInitials(name: string) {
  const ascii = name.replace(/[^\w\s]/g, ' ').trim();
  const parts = ascii.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function ProviderStep({ llm, onBack, onContinue }: ProviderStepProps) {
  const { t } = useTranslation('onboarding');

  return (
    <div className="content-page">
      <header className="page-intro">
        <h1>{t('provider.title')}</h1>
        <p className="intro-copy">{t('provider.intro')}</p>
      </header>

      <div className="provider-grid">
        {CATALOG_PROVIDERS.map((provider) => {
          const selected = llm.selectedProvider?.id === provider.id;
          return (
            <button
              key={provider.id}
              className={`provider-card${selected ? ' selected' : ''}`}
              type="button"
              aria-pressed={selected}
              aria-label={provider.displayName}
              onClick={() => llm.handleProviderSelect(provider)}
            >
              <span className="provider-icon" aria-hidden="true">
                {providerInitials(provider.displayName)}
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
        <button
          className={`provider-card custom-provider${llm.isCustomMode ? ' selected' : ''}`}
          type="button"
          aria-pressed={llm.isCustomMode}
          aria-label={t('provider.customTitle')}
          onClick={() => llm.handleProviderSelect(CUSTOM_PROVIDER)}
        >
          <span className="provider-icon" aria-hidden="true">+</span>
          <span className="provider-copy">
            <span className="provider-title-row">
              <strong>{t('provider.customTitle')}</strong>
            </span>
            <small>{t('provider.customHint')}</small>
          </span>
          <span className="radio-dot" aria-hidden="true">
            {llm.isCustomMode && <RadioCheckIcon />}
          </span>
        </button>
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
