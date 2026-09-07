import { ServerCrash } from 'lucide-react';
import AuthScreenLayout from './AuthScreenLayout';

type GatewayRuntimeErrorScreenProps = {
  error: string;
  onRetry: () => void | Promise<void>;
};

export default function GatewayRuntimeErrorScreen({
  error,
  onRetry,
}: GatewayRuntimeErrorScreenProps) {
  return (
    <AuthScreenLayout
      title="Gateway failed to start"
      description="Your model configuration was saved, but the local Gateway is unavailable."
      footerText="The Web UI will stay available while you retry."
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-destructive/10">
          <ServerCrash className="h-8 w-8 text-destructive" />
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="break-words text-sm text-destructive">{error}</p>
        </div>
        <button
          type="button"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => void onRetry()}
        >
          Retry Gateway
        </button>
      </div>
    </AuthScreenLayout>
  );
}
