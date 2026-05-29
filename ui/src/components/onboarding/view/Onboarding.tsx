import { useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { Settings, ArrowRight, Sparkles } from 'lucide-react';

type OnboardingProps = {
  onComplete?: () => void | Promise<void>;
};

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [isCompleting, setIsCompleting] = useState(false);

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const response = await authenticatedFetch('/api/user/complete-onboarding', { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to complete onboarding');
      }
      await onComplete?.();
    } catch (caughtError) {
      console.error('Onboarding completion failed:', caughtError);
    } finally {
      setIsCompleting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-2xl">
        <div className="rounded-xl border border-border bg-card p-8 space-y-8">
          {/* Header */}
          <div className="text-center space-y-3">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">Welcome to PilotDeck</h1>
            <p className="text-muted-foreground max-w-md mx-auto">
              Your AI agent operating system for productive, multi-project workflows.
            </p>
          </div>

          <div className="border-t border-border" />

          {/* Quick Start Guide */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-foreground text-center">Quick Start</h2>
            
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-center space-y-2">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  1
                </div>
                <h3 className="font-medium text-foreground">Complete Setup</h3>
                <p className="text-xs text-muted-foreground">
                  Click the button below to enter the main interface
                </p>
              </div>
              
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-center space-y-2">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  2
                </div>
                <h3 className="font-medium text-foreground">Configure Model</h3>
                <p className="text-xs text-muted-foreground">
                  Open Settings and add your LLM provider API key
                </p>
              </div>
              
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-center space-y-2">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  3
                </div>
                <h3 className="font-medium text-foreground">Start Creating</h3>
                <p className="text-xs text-muted-foreground">
                  Create a WorkSpace and begin your AI-powered workflow
                </p>
              </div>
            </div>
          </div>

          {/* Supported Providers */}
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-medium text-foreground mb-3">Supported LLM Providers</h3>
            <div className="flex flex-wrap gap-2">
              {['OpenAI', 'Anthropic', 'DeepSeek', 'Google AI', 'MiniMax', 'SiliconFlow', 'OpenRouter'].map((provider) => (
                <span
                  key={provider}
                  className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {provider}
                </span>
              ))}
            </div>
          </div>

          {/* Action */}
          <div className="flex flex-col items-center gap-4 pt-4">
            <button
              type="button"
              onClick={handleComplete}
              disabled={isCompleting}
              className="inline-flex items-center gap-2 rounded-lg bg-foreground px-6 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCompleting ? (
                'Entering...'
              ) : (
                <>
                  Enter PilotDeck
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
            
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Settings className="h-3 w-3" />
              You can configure your LLM provider in Settings anytime
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
