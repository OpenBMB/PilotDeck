import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import {
  PILOTDECK_SETTINGS_KEY,
  fetchPilotDeckPermissionSettings,
  getPilotDeckSettings,
  safeLocalStorage,
} from "../../../chat/utils/chatStorage";
import type { PilotDeckSettings } from "../../../chat/types/types";
import { PageSectionHeader } from "../../shared/view";
import type { StatusBanner } from "./types";
import { QUICK_ADD_TOOLS, QUICK_BLOCK_TOOLS } from "./utils/constants";
import {
  addUnique,
  buildExportPayload,
  downloadJson,
  mergeUnique,
  parsePermissionsImport,
  persistPermissionSettings,
  removeValue,
} from "./utils/permissions";
import { readTelemetryEnabled, setTelemetryEnabled } from "./utils/telemetry";
import PermissionControlSection from "./components/PermissionControlSection";
import PermissionRulesSection from "./components/PermissionRulesSection";
import TelemetrySection from "./components/TelemetrySection";

type PrivacySectionsProps = {
  title: string;
};

export default function PrivacySections({ title }: PrivacySectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading } = usePilotDeckConfig();
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [disallowedTools, setDisallowedTools] = useState<string[]>([]);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [newAllowed, setNewAllowed] = useState("");
  const [newBlocked, setNewBlocked] = useState("");
  const [banner, setBanner] = useState<StatusBanner>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const telemetryEnabled = useMemo(() => readTelemetryEnabled(raw), [raw]);

  const reload = useCallback(() => {
    const settings = getPilotDeckSettings();
    setAllowedTools(settings.allowedTools);
    setDisallowedTools(settings.disallowedTools);
    setSkipPermissions(settings.skipPermissions);
  }, []);

  useEffect(() => {
    reload();
    fetchPilotDeckPermissionSettings()
      .then((settings) => {
        safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(settings));
        setAllowedTools(settings.allowedTools);
        setDisallowedTools(settings.disallowedTools);
        setSkipPermissions(settings.skipPermissions);
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
    setAllowedTools(next);
    persistPermissionSettings({ allowedTools: next });
    setNewAllowed("");
  };

  const handleRemoveAllowed = (value: string) => {
    const next = removeValue(allowedTools, value);
    setAllowedTools(next);
    persistPermissionSettings({ allowedTools: next });
  };

  const handleAddBlocked = (value: string) => {
    const next = addUnique(disallowedTools, value);
    if (next === disallowedTools) return;
    setDisallowedTools(next);
    persistPermissionSettings({ disallowedTools: next });
    setNewBlocked("");
  };

  const handleRemoveBlocked = (value: string) => {
    const next = removeValue(disallowedTools, value);
    setDisallowedTools(next);
    persistPermissionSettings({ disallowedTools: next });
  };

  const handleSkipPermissionsChange = (value: boolean) => {
    setSkipPermissions(value);
    persistPermissionSettings({ skipPermissions: value });
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

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const handleExport = () => {
    try {
      const payload = buildExportPayload();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`pilotdeck-permissions-${stamp}.json`, payload);
      setBanner({
        kind: "success",
        message: t("permissions.exportSuccess", {
          allowed: payload.allowedTools.length,
          blocked: payload.disallowedTools.length,
          defaultValue: "Exported {{allowed}} allowed and {{blocked}} blocked tools.",
        }),
      });
    } catch (error) {
      console.error("Failed to export permissions:", error);
      setBanner({
        kind: "error",
        message: t("permissions.exportError", {
          defaultValue: "Failed to export permissions.",
        }),
      });
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    let fileRaw = "";
    try {
      fileRaw = await file.text();
    } catch (error) {
      console.error("Failed to read import file:", error);
      setBanner({
        kind: "error",
        message: t("permissions.importReadError", {
          defaultValue: "Could not read the selected file.",
        }),
      });
      return;
    }

    const parsed = parsePermissionsImport(fileRaw);
    if (!parsed) {
      setBanner({
        kind: "error",
        message: t("permissions.importInvalid", {
          defaultValue:
            "Not a valid permissions export. Expected JSON with allowedTools / disallowedTools.",
        }),
      });
      return;
    }

    const summary = t("permissions.importConfirmBody", {
      allowed: parsed.allowedTools.length,
      blocked: parsed.disallowedTools.length,
      defaultValue:
        "Merge {{allowed}} allowed and {{blocked}} blocked tools into your existing permissions?",
    });
    if (!window.confirm(summary)) {
      setBanner(null);
      return;
    }

    const current = getPilotDeckSettings();
    const nextAllowed = mergeUnique(current.allowedTools, parsed.allowedTools);
    const nextBlocked = mergeUnique(current.disallowedTools, parsed.disallowedTools);
    const updates: Partial<PilotDeckSettings> = {
      allowedTools: nextAllowed,
      disallowedTools: nextBlocked,
      ...(parsed.skipPermissions !== undefined
        ? { skipPermissions: parsed.skipPermissions }
        : {}),
    };
    persistPermissionSettings(updates);

    setAllowedTools(nextAllowed);
    setDisallowedTools(nextBlocked);
    if (parsed.skipPermissions !== undefined) {
      setSkipPermissions(parsed.skipPermissions);
    }

    const addedAllowed = nextAllowed.length - current.allowedTools.length;
    const addedBlocked = nextBlocked.length - current.disallowedTools.length;
    setBanner({
      kind: "success",
      message: t("permissions.importSuccess", {
        addedAllowed,
        addedBlocked,
        defaultValue:
          "Imported. Added {{addedAllowed}} allowed and {{addedBlocked}} blocked tools.",
      }),
    });
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <PageSectionHeader
        title={t("permissions.controlTitle", { defaultValue: "权限控制" })}
      />

      <PermissionControlSection
        fileInputRef={fileInputRef}
        onFileChosen={handleFileChosen}
        onExport={handleExport}
        onImportClick={handleImportClick}
        banner={banner}
        skipPermissions={skipPermissions}
        onSkipPermissionsChange={handleSkipPermissionsChange}
      />

      <PermissionRulesSection
        mode="allowed"
        tools={allowedTools}
        newValue={newAllowed}
        onNewValueChange={setNewAllowed}
        onAdd={handleAddAllowed}
        onRemove={handleRemoveAllowed}
        quickTools={QUICK_ADD_TOOLS}
        icon={Shield}
      />

      <PermissionRulesSection
        mode="blocked"
        tools={disallowedTools}
        newValue={newBlocked}
        onNewValueChange={setNewBlocked}
        onAdd={handleAddBlocked}
        onRemove={handleRemoveBlocked}
        quickTools={QUICK_BLOCK_TOOLS}
        icon={AlertTriangle}
      />

      <TelemetrySection
        enabled={telemetryEnabled}
        loading={loading}
        onToggle={handleTelemetryToggle}
      />
    </div>
  );
}
