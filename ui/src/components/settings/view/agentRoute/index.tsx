import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import RouterSection from "./components/RouterSection";

type AgentRouteSectionsProps = {
  title: string;
};

export default function AgentRouteSections({ title: _title }: AgentRouteSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise agent route config patch", caught);
    }
  };

  if (loading) {
    return (
      <div className="route-page-content">
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="route-page-content">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.agentRoute")}
        </div>
      </div>
    );
  }

  return (
    <>
      <ConfigSaveError error={error} />
      <RouterSection config={parsedConfig} onChange={onFormChange} />
    </>
  );
}
