import { useTranslation } from 'react-i18next';

export default function OnboardingTopbar() {
  const { t } = useTranslation('onboarding');

  return (
    <header className="topbar">
      <div className="topbar-brand-group">
        <div className="brand" aria-label={t('brand')}>
          <img className="brand-lockup" alt={t('brand')} src="/pilotdeck-logo-lockup-transparent.png" />
        </div>
      </div>
    </header>
  );
}
