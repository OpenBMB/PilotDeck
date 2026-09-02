import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import {
  PILOTDECK_SETTINGS_KEY,
  fetchPilotDeckPermissionSettings,
  getPilotDeckSettings,
  safeLocalStorage,
} from "../../../chat/utils/chatStorage";
import { ConfigSaveError } from "../../shared/view";
import { QUICK_ADD_TOOLS, QUICK_BLOCK_TOOLS } from "./utils/constants";
import { addUnique, persistPermissionSettings, removeValue } from "./utils/permissions";
import { readTelemetryEnabled, setTelemetryEnabled } from "./utils/telemetry";
import PermissionRulesSection from "./components/PermissionRulesSection";
import TelemetrySection from "./components/TelemetrySection";
import { showSettingsSuccess } from "../../shared/SettingsSuccessToast";

type PrivacySectionsProps = {
  title: string;
};

export default function PrivacySections({ title }: PrivacySectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [askTools, setAskTools] = useState<string[]>([]);
  const [newAllowed, setNewAllowed] = useState("");
  const [newApproval, setNewApproval] = useState("");
  const telemetryEnabled = useMemo(() => readTelemetryEnabled(raw), [raw]);

  const reload = useCallback(() => {
    const settings = getPilotDeckSettings();
    setAllowedTools(settings.allowedTools);
    setAskTools(settings.askTools);
  }, []);

  useEffect(() => {
    reload();
    fetchPilotDeckPermissionSettings()
      .then((settings) => {
        safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(settings));
        // The bypass control was removed from this page. Keep the effective
        // policy in confirmation mode so explicit ask rules can take effect.
        if (settings.skipPermissions) {
          persistPermissionSettings({ skipPermissions: false });
        }
        setAllowedTools(settings.allowedTools);
        setAskTools(settings.askTools);
      })
      .catch((error) => {
        console.error("Failed to load permission settings from backend:", error);
      });

    const onStorage = (event: StorageEvent) => {
      if (event.key === PILOTDECK_SETTINGS_KEY) reload();
    };
    const onCustom = () => reload();
    window.addEventListener("storage", onStorage);
    window.addEventListener("pilotdeck-settings-changed", onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pilotdeck-settings-changed", onCustom);
    };
  }, [reload]);

  const handleAddAllowed = (value: string) => {
    const next = addUnique(allowedTools, value);
    if (next === allowedTools) return;
    const tool = value.trim();
    const settings = getPilotDeckSettings();
    const nextAsk = removeValue(askTools, tool);
    const nextDisallowed = removeValue(settings.disallowedTools, tool);
    setAllowedTools(next);
    setAskTools(nextAsk);
    persistPermissionSettings({
      allowedTools: next,
      askTools: nextAsk,
      disallowedTools: nextDisallowed,
    });
    setNewAllowed("");
    showSettingsSuccess(t("permissions.feedback.allowedAdded", { tool }));
  };

  const handleRemoveAllowed = (value: string) => {
    const next = removeValue(allowedTools, value);
    setAllowedTools(next);
    persistPermissionSettings({ allowedTools: next });
    showSettingsSuccess(t("permissions.feedback.allowedRemoved", { tool: value }));
  };

  const handleAddApproval = (value: string) => {
    const next = addUnique(askTools, value);
    if (next === askTools) return;
    const tool = value.trim();
    const settings = getPilotDeckSettings();
    const nextAllowed = removeValue(allowedTools, tool);
    const nextDisallowed = removeValue(settings.disallowedTools, tool);
    setAskTools(next);
    setAllowedTools(nextAllowed);
    persistPermissionSettings({
      askTools: next,
      allowedTools: nextAllowed,
      disallowedTools: nextDisallowed,
    });
    setNewApproval("");
    showSettingsSuccess(t("permissions.feedback.approvalAdded", { tool }));
  };

  const handleRemoveApproval = (value: string) => {
    const next = removeValue(askTools, value);
    setAskTools(next);
    persistPermissionSettings({ askTools: next });
    showSettingsSuccess(t("permissions.feedback.approvalRemoved", { tool: value }));
  };

  const handleTelemetryToggle = useCallback(
    (value: boolean) => {
      const nextRaw = setTelemetryEnabled(raw, value);
      if (!nextRaw) return;
      setRaw(nextRaw);
      void save();
    },
    [raw, save, setRaw],
  );

  return (
    <div className="security-page-content">
      <span className="sr-only">{title}</span>
      <ConfigSaveError error={error} />
      <section className="security-section" aria-labelledby="security-permissions-title">
        <div className="security-card security-permissions-card">
          <header className="security-card-header">
            <span className="security-card-header-icon" aria-hidden="true">
              <ShieldCheck size={19} />
            </span>
            <div>
              <h2 id="security-permissions-title">{t("permissions.controlTitle")}</h2>
              <p>{t("permissions.controlDescription")}</p>
            </div>
          </header>
          <div className="security-permission-grid">
            <PermissionRulesSection
              mode="allowed"
              tools={allowedTools}
              newValue={newAllowed}
              onNewValueChange={setNewAllowed}
              onAdd={handleAddAllowed}
              onRemove={handleRemoveAllowed}
              quickTools={QUICK_ADD_TOOLS}
            />
            <PermissionRulesSection
              mode="approval"
              tools={askTools}
              newValue={newApproval}
              onNewValueChange={setNewApproval}
              onAdd={handleAddApproval}
              onRemove={handleRemoveApproval}
              quickTools={QUICK_BLOCK_TOOLS}
            />
          </div>
        </div>
      </section>

      <TelemetrySection
        enabled={telemetryEnabled}
        loading={loading}
        onToggle={handleTelemetryToggle}
      />
    </div>
  );
}
