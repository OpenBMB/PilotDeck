import { useCallback, useEffect, useMemo, useState } from "react";
import { PilotDeckConfigProvider } from "../../hooks/usePilotDeckConfig";
import { authenticatedFetch } from "../../utils/api";
import type { SettingsProps } from "./shared/types";
import type { SettingsMenuKey } from "./types";
import { mapInitialTabToMenuKey } from "./navigation";
import SettingsSidebar from "./view/SettingsSidebar";
import SettingsContent from "./view/SettingsContent";

export type DesktopVersionCheckResult = {
  mode: "desktop" | "web";
  hasUpdate: boolean;
  checkUnavailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  buildTime: string | null;
};

function normalizeDesktopVersionResult(payload: any): DesktopVersionCheckResult {
  return {
    mode: "desktop",
    hasUpdate: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.current?.version ?? "unknown",
    latestVersion: payload?.latest?.version ?? null,
    latestPublishedAt: payload?.latest?.publishedAt ?? null,
    buildTime: payload?.current?.buildTime ?? null,
  };
}

function normalizeWebVersionResult(payload: any): DesktopVersionCheckResult {
  return {
    mode: "web",
    hasUpdate: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.localHead ?? "unknown",
    latestVersion: payload?.remoteHead ?? null,
    latestPublishedAt: null,
    buildTime: null,
  };
}

function SettingsInner({
  isOpen,
  onClose,
  projects = [],
  initialTab,
}: SettingsProps) {
  const isDesktopApp =
    typeof window !== "undefined" && !!(window as any).pilotdeckDesktop;
  const initialKey = useMemo(
    () => mapInitialTabToMenuKey(initialTab),
    [initialTab],
  );
  const [selectedKey, setSelectedKey] =
    useState<SettingsMenuKey>(initialKey);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(
    initialKey === "general",
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
    if (!isOpen) return;
    const nextKey = mapInitialTabToMenuKey(initialTab);
    setSelectedKey(nextKey);
    setMobileNavigationOpen(nextKey === "general");
    void checkVersion();
  }, [isOpen, initialTab, checkVersion]);

  const selectMenuItem = useCallback((key: SettingsMenuKey) => {
    setSelectedKey(key);
    setMobileNavigationOpen(false);
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      <div className="relative flex h-full w-full overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-7xl md:rounded-xl">
        <div className="flex h-full w-full flex-col md:flex-row">
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
            mobileVisible={!mobileNavigationOpen}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
          />
        </div>
      </div>
    </div>
  );
}

export default function Settings(props: SettingsProps) {
  return (
    <PilotDeckConfigProvider>
      <SettingsInner {...props} />
    </PilotDeckConfigProvider>
  );
}
