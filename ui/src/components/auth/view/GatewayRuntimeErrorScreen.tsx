import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('common');
  const logPath = error.match(/^Runtime log:\s*(.+)$/m)?.[1];
  return (
    <AuthScreenLayout
      title={t('common:uiText.gatewayFailed')}
      description={t('common:uiText.gatewayUnavailable')}
      footerText={t('common:uiText.gatewayRetryHint')}
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-destructive/10">
          <ServerCrash className="h-8 w-8 text-destructive" />
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm text-destructive">{error}</p>
        </div>
        {logPath && <p className="break-all text-xs text-muted-foreground">{t('common:uiText.runtimeLogLocation')}: {logPath}</p>}
        <button
          type="button"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => void onRetry()}
        >
          {t('common:uiText.retryGateway')}
        </button>
        {window.pilotdeckDesktop?.openRuntimeLog && (
          <button
            type="button"
            className="w-full rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
            onClick={() => void window.pilotdeckDesktop?.openRuntimeLog()}
          >
            {t('common:uiText.openRuntimeLog')}
          </button>
        )}
      </div>
    </AuthScreenLayout>
  );
}
