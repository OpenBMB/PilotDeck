import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
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
  const { t } = useTranslation('settings');
  const errors = configuration.state === 'invalid'
    ? configuration.errors
    : [configuration.error];
  const code = configuration.state === 'invalid' ? 'PD_CONFIG_INVALID' : 'PD_CONFIG_STATUS_UNAVAILABLE';
  const [logPath, setLogPath] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const location = window.pilotdeckDesktop?.getRuntimeInfo
      ? window.pilotdeckDesktop.getRuntimeInfo().then(info => info?.logPath)
      : authenticatedFetch('/api/diagnostics/location', { signal: AbortSignal.timeout(5000) }).then(response => response.ok ? response.json() : null).then(value => value?.logPath);
    void location.then(value => { if (active && typeof value === 'string') setLogPath(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  return (
    <AuthScreenLayout
      title={t('common:uiText.modelUnavailable')}
      description={t('common:uiText.modelInvalid')}
      footerText={t('common:uiText.fixAndRetry')}
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
      )}
    >
      <div className="space-y-4">
        <p className="font-mono text-xs text-muted-foreground">{code}</p>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          {errors.map((message) => (
            <p key={message} className="break-words text-sm text-destructive">
              {message}
            </p>
          ))}
        </div>
        {configuration.state === 'invalid' && configuration.configPath && <p className="break-all text-xs text-muted-foreground">{t('common:uiText.configurationFile')}: {configuration.configPath}</p>}
        {logPath && <p className="break-all text-xs text-muted-foreground">{t('common:uiText.runtimeLogLocation')}: {logPath}</p>}
        <Link className="block text-center text-primary underline" to="/settings/models">
          {t('openModelSettings')}
        </Link>
        <button
          type="button"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => void onRetry()}
        >
          {t('common:uiText.retry')}
        </button>
        {window.pilotdeckDesktop?.openRuntimeLog && <button type="button" className="w-full rounded-md border px-4 py-2 text-sm font-medium" onClick={() => void window.pilotdeckDesktop?.openRuntimeLog()}>{t('common:uiText.openRuntimeLog')}</button>}
      </div>
    </AuthScreenLayout>
  );
}
