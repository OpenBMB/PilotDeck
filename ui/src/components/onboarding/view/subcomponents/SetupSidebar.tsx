import { useTranslation } from 'react-i18next';
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from '../constants';
import { ShieldCheckIcon, StepCheckIcon } from './icons';

type SetupSidebarProps = {
  currentStep: OnboardingStepId;
};

export default function SetupSidebar({ currentStep }: SetupSidebarProps) {
  const { t } = useTranslation('onboarding');
  const currentIndex = ONBOARDING_STEP_IDS.indexOf(currentStep);

  return (
    <aside className="setup-sidebar">
      <div>
        <div className="setup-icon" aria-hidden="true">
          <img alt="" src="/pilotdeck-p-mark-transparent-v2.png" />
        </div>
        <p className="sidebar-kicker">{t('sidebar.kicker')}</p>
        <h2>{t('sidebar.title')}</h2>
        <ol className="progress-rail" aria-label="Setup progress">
          {ONBOARDING_STEP_IDS.map((stepId, index) => {
            const status = index < currentIndex ? 'done' : index === currentIndex ? 'active' : '';
            return (
              <li
                key={stepId}
                className={status}
                aria-current={index === currentIndex ? 'step' : undefined}
              >
                <span className="step-marker" aria-hidden="true">
                  {status === 'done' ? <StepCheckIcon /> : index + 1}
                </span>
                <span>{t(`steps.${stepId}`)}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="privacy-note">
        <ShieldCheckIcon />
        <strong>{t('sidebar.privacyTitle')}</strong>
      </div>
    </aside>
  );
}
