import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PilotDeckConfigProvider } from "../../hooks/usePilotDeckConfig";
import { desktopUpdates } from "../../utils/desktopUpdates";
import { authenticatedFetch } from "../../utils/api";
import type { SettingsProps } from "./shared/types";
import type { SettingsMenuKey } from "./types";
import { getSettingsPath, mapSettingsSectionToMenuKey } from "./navigation";
import {
  normalizeDesktopVersionResult,
  normalizeWebVersionResult,
  type DesktopVersionCheckResult,
} from "./version";
import SettingsSidebar from "./view/SettingsSidebar";
import SettingsContent from "./view/SettingsContent";
import { SettingsSuccessToastProvider } from "./shared/SettingsSuccessToast";
import "./settings-page.css";

export type { DesktopVersionCheckResult } from "./version";

function SettingsInner({
  onClose,
  projects = [],
  section,
}: SettingsProps) {
  const navigate = useNavigate();
  const isDesktopApp =
    typeof window !== "undefined" && !!(window as any).pilotdeckDesktop;
  const selectedKey = mapSettingsSectionToMenuKey(section);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(
    selectedKey === "general",
  );
  const [versionInfo, setVersionInfo] = useState<DesktopVersionCheckResult>({
    mode: isDesktopApp ? "desktop" : "web",
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: "unknown",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  });
  const [checkingVersion, setCheckingVersion] = useState(false);

  const checkVersion = useCallback(async () => {
    setCheckingVersion(true);
    try {
      let data;
      if (isDesktopApp) {
        data = await desktopUpdates().checkUpdates();
      } else {
        const res = await authenticatedFetch("/api/update/info");
        if (!res.ok) throw new Error("Failed to read local version");
        data = await res.json();
      }
      setVersionInfo(
        isDesktopApp
          ? normalizeDesktopVersionResult(data)
          : normalizeWebVersionResult(data),
      );
    } catch {
      setVersionInfo((prev) => ({
        ...prev,
        hasUpdate: false,
        checkUnavailable: true,
        canUpdate: false,
        canDownload: false,
        desktopReason: "checkFailed",
        webReason: "checkFailed",
      }));
    } finally {
      setCheckingVersion(false);
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void checkVersion();
  }, [checkVersion]);

  useEffect(() => {
    if (selectedKey !== "general") setMobileNavigationOpen(false);
  }, [selectedKey]);

  const selectMenuItem = useCallback(
    (key: SettingsMenuKey) => {
      setMobileNavigationOpen(false);
      navigate(getSettingsPath(key));
    },
    [navigate],
  );

  return (
    <div className="pilotdeck-settings-app">
      <SettingsSidebar
        selectedKey={selectedKey}
        onSelect={selectMenuItem}
        onClose={onClose}
        showAboutDot={versionInfo.hasUpdate}
        mobileVisible={mobileNavigationOpen}
      />
      <SettingsContent
        selectedKey={selectedKey}
        projects={projects}
        versionInfo={versionInfo}
        checkingVersion={checkingVersion}
        onCloseSettings={onClose}
        mobileVisible={!mobileNavigationOpen}
        onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
      />
    </div>
  );
}

export default function Settings(props: SettingsProps) {
  return (
    <SettingsSuccessToastProvider>
      <PilotDeckConfigProvider>
        <SettingsInner {...props} />
      </PilotDeckConfigProvider>
    </SettingsSuccessToastProvider>
  );
}
