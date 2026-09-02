import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PilotDeckConfigProvider } from "../../hooks/usePilotDeckConfig";
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
      const res = isDesktopApp
        ? await authenticatedFetch("/api/update/desktop/check", {
            method: "POST",
          })
        : await authenticatedFetch("/api/update/check", {
            method: "POST",
          });
      if (!res.ok) {
        throw new Error("Failed to check version");
      }
      const data = await res.json();
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
      }));
    } finally {
      setCheckingVersion(false);
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void checkVersion();
  }, [checkVersion]);

  useEffect(() => {
    setMobileNavigationOpen(selectedKey === "general");
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
