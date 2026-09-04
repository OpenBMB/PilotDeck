import { useCallback, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from './constants';
import useLlmSetup from './hooks/useLlmSetup';
import useOnboardingWorkspace from './hooks/useOnboardingWorkspace';
import ConnectionStep from './subcomponents/ConnectionStep';
import LanguageStep from './subcomponents/LanguageStep';
import ProviderStep from './subcomponents/ProviderStep';
import SetupSidebar from './subcomponents/SetupSidebar';
import WorkspaceStep from './subcomponents/WorkspaceStep';
import './Onboarding.css';

type OnboardingProps = {
  onComplete?: () => void | Promise<void>;
};

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState<OnboardingStepId>('language');
  const [completeError, setCompleteError] = useState('');
  const llm = useLlmSetup();
  const workspace = useOnboardingWorkspace();

  const goTo = useCallback((step: OnboardingStepId) => {
    setCompleteError('');
    setCurrentStep(step);
  }, []);

  const goBack = useCallback(() => {
    const index = ONBOARDING_STEP_IDS.indexOf(currentStep);
    if (index > 0) {
      goTo(ONBOARDING_STEP_IDS[index - 1]);
    }
  }, [currentStep, goTo]);

  const goNext = useCallback(() => {
    const index = ONBOARDING_STEP_IDS.indexOf(currentStep);
    if (index < ONBOARDING_STEP_IDS.length - 1) {
      goTo(ONBOARDING_STEP_IDS[index + 1]);
    }
  }, [currentStep, goTo]);

  const handleConnectionContinue = useCallback(async () => {
    try {
      await llm.handleSave();
      goNext();
    } catch {
      /* error is surfaced by the connection form */
    }
  }, [goNext, llm]);

  const handleFinish = useCallback(async () => {
    setCompleteError('');
    try {
      await workspace.createWorkspace();
      const response = await authenticatedFetch('/api/user/complete-onboarding', { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to complete onboarding');
      }
      await onComplete?.();
    } catch (caughtError) {
      setCompleteError(caughtError instanceof Error ? caughtError.message : 'Failed to complete onboarding');
    }
  }, [onComplete, workspace]);

  const handleSkipChat = useCallback(async () => {
    setCompleteError('');
    try {
      const response = await authenticatedFetch('/api/user/complete-onboarding', { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to complete onboarding');
      }
      await onComplete?.();
    } catch (caughtError) {
      setCompleteError(caughtError instanceof Error ? caughtError.message : 'Failed to complete onboarding');
    }
  }, [onComplete]);

  return (
    <main className="onboarding-shell prototype-shell desktop-prototype-shell" data-platform="desktop">
      <section className="onboarding-frame" aria-live="polite">
        <SetupSidebar currentStep={currentStep} />
        <div className="setup-content">
          {currentStep === 'language' && (
            <LanguageStep onContinue={goNext} />
          )}
          {currentStep === 'provider' && (
            <ProviderStep llm={llm} onBack={goBack} onContinue={goNext} />
          )}
          {currentStep === 'connection' && (
            <ConnectionStep llm={llm} onBack={goBack} onContinue={handleConnectionContinue} />
          )}
          {currentStep === 'workspace' && (
            <WorkspaceStep
              draft={workspace.draft}
              error={completeError || workspace.error}
              progress={workspace.progress}
              isCreating={workspace.isCreating}
              onWorkspacePathChange={workspace.setWorkspacePath}
              onGithubUrlChange={workspace.setGithubUrl}
              onBack={goBack}
              onSkipChat={handleSkipChat}
              onFinish={handleFinish}
            />
          )}
        </div>
      </section>
    </main>
  );
}
