import { useCallback, useEffect, useState } from 'react';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { desktopUpdates } from '../../utils/desktopUpdates';
import { authenticatedFetch } from '../../utils/api';
import {
  normalizeDesktopVersionResult,
  normalizeWebVersionResult,
  type DesktopVersionCheckResult,
} from '../../components/settings/version';
import AboutSections from '../../components/settings/view/about';

function SystemUpdatesSettings({ onClose }: SurfaceProps) {
  const isDesktopApp = typeof window !== 'undefined' && !!(window as any).pilotdeckDesktop;
  const [versionInfo, setVersionInfo] = useState<DesktopVersionCheckResult>({
    mode: isDesktopApp ? 'desktop' : 'web',
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: 'unknown',
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  });
  const [checkingVersion, setCheckingVersion] = useState(false);

  const checkVersion = useCallback(async () => {
    setCheckingVersion(true);
    try {
      const data = isDesktopApp
        ? await desktopUpdates().checkUpdates()
        : await (async () => {
          const response = await authenticatedFetch('/api/update/check', { method: 'POST' });
          if (!response.ok) throw new Error('Failed to check version');
          return response.json();
        })();
      setVersionInfo(isDesktopApp ? normalizeDesktopVersionResult(data) : normalizeWebVersionResult(data));
    } catch {
      setVersionInfo((previous) => ({
        ...previous,
        hasUpdate: false,
        checkUnavailable: true,
        canUpdate: false,
        canDownload: false,
        desktopReason: 'checkFailed',
        webReason: 'checkFailed',
      }));
    } finally {
      setCheckingVersion(false);
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void checkVersion();
  }, [checkVersion]);

  return <AboutSections title="About" versionInfo={versionInfo} checkingVersion={checkingVersion} onRestartConfirmed={onClose} />;
}

const module: FrontendModule = {
  id: 'system.updates', businessModuleId: 'system.updates', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [{ id: 'system-updates', settingsSection: 'system-updates', label: 'About', component: SystemUpdatesSettings }],
};
export default module;
