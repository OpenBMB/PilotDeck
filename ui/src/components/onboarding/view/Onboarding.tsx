import { useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import LlmConfigurationStep from './subcomponents/LlmConfigurationStep';

type OnboardingProps = {
  onComplete?: () => void | Promise<void>;
};

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [errorMessage, setErrorMessage] = useState('');

  const handleSaved = async () => {
    setErrorMessage('');
    try {
      const response = await authenticatedFetch('/api/user/complete-onboarding', { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to complete onboarding');
      }
      await onComplete?.();
    } catch (caughtError) {
      setErrorMessage(caughtError instanceof Error ? caughtError.message : 'Failed to complete onboarding');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-2xl">
        <div className="rounded-xl border border-border bg-card p-8">
          <LlmConfigurationStep onSaved={handleSaved} />

          {errorMessage && (
            <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800/40 dark:bg-red-900/10">
              <p className="text-sm text-red-700 dark:text-red-300">{errorMessage}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
