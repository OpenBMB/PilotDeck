import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsProject } from "../../shared/types";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import AlwaysOnSection from "./components/AlwaysOnSection";

type AgentResidentSectionsProps = {
  title: string;
  projects: SettingsProject[];
};

export default function AgentResidentSections({
  title: _title,
  projects,
}: AgentResidentSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise agent resident config patch", caught);
    }
  };

  if (loading) {
    return (
      <div className="resident-page-content">
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="resident-page-content">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.agentResident")}
        </div>
      </div>
    );
  }

  return (
    <div className="resident-page-content">
      <ConfigSaveError error={error} />
      <AlwaysOnSection
        config={parsedConfig}
        projects={projects}
        onChange={onFormChange}
      />
    </div>
  );
}
