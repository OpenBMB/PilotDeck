import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PilotDeckConfigProvider } from "../../hooks/usePilotDeckConfig";
import type { SettingsProps } from "./shared/types";
import type { SettingsMenuKey } from "./types";
import { getSettingsPath, mapSettingsSectionToMenuKey } from "./navigation";
import SettingsSidebar from "./view/SettingsSidebar";
import SettingsContent from "./view/SettingsContent";
import { SettingsSuccessToastProvider } from "./shared/SettingsSuccessToast";
import "./settings-page.css";

function SettingsInner({
  onClose,
  projects = [],
  section,
  moduleSettings = [],
  host,
}: SettingsProps) {
  const navigate = useNavigate();
  const selectedKey = mapSettingsSectionToMenuKey(section);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(
    selectedKey === "general",
  );
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
        mobileVisible={mobileNavigationOpen}
        moduleSettings={moduleSettings}
      />
      <SettingsContent
        selectedKey={selectedKey}
        projects={projects}
        onCloseSettings={onClose}
        mobileVisible={!mobileNavigationOpen}
        onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
        moduleSettings={moduleSettings}
        host={host}
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
