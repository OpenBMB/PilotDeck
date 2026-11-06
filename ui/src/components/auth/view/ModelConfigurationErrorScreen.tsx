import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type { ModelConfigurationState } from '../types';
import StartupErrorPanel from './StartupErrorPanel';

type ModelConfigurationErrorScreenProps = {
  configuration: Extract<ModelConfigurationState, { state: 'invalid' | 'status_error' }>;
  onRetry: () => void | Promise<void>;
};

export default function ModelConfigurationErrorScreen({
  configuration,
  onRetry,
}: ModelConfigurationErrorScreenProps) {
  const { t } = useTranslation('settings');
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
    <StartupErrorPanel error={code} logPath={logPath} onRetry={() => window.pilotdeckDesktop?.retryRuntime ? window.pilotdeckDesktop.retryRuntime() : onRetry()}>
      <Link className="mt-3 block text-sm text-[var(--pd-accent-strong,#4948cf)] underline" to="/settings/models">
        {t('openModelSettings')}
      </Link>
    </StartupErrorPanel>
  );
}
