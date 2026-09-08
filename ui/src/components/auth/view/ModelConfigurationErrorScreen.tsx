import { AlertTriangle } from 'lucide-react';
import type { ModelConfigurationState } from '../types';
import AuthScreenLayout from './AuthScreenLayout';

type ModelConfigurationErrorScreenProps = {
  configuration: Extract<ModelConfigurationState, { state: 'invalid' | 'status_error' }>;
  onRetry: () => void | Promise<void>;
};

export default function ModelConfigurationErrorScreen({
  configuration,
  onRetry,
}: ModelConfigurationErrorScreenProps) {
  const errors = configuration.state === 'invalid'
    ? configuration.errors
    : [configuration.error];

  return (
    <AuthScreenLayout
      title="Model configuration unavailable"
      description="PilotDeck could not validate the model configuration."
      footerText="Fix the configuration, then retry."
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          {errors.map((message) => (
            <p key={message} className="break-words text-sm text-destructive">
              {message}
            </p>
          ))}
        </div>
        <button
          type="button"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => void onRetry()}
        >
          Retry
        </button>
      </div>
    </AuthScreenLayout>
  );
}
