import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig, type ConfigSaveResult } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import RouterSection from "./components/RouterSection";
import ModelReferenceDetail from '../../shared/view/ModelReferenceDetail';

type AgentRouteSectionsProps = {
  title: string;
  reference?: string | null;
};

export default function AgentRouteSections({ title: _title, reference }: AgentRouteSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = async (next: PilotDeckConfig): Promise<ConfigSaveResult> => {
    try {
      return await commitRaw(configToYamlString(next));
    } catch (caught) {
      console.error("Failed to serialise agent route config patch", caught);
      return { ok: false, error: caught instanceof Error ? caught.message : t("pilotDeckConfig.panels.agents.subagents.timeoutSaveFailed") };
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
      <ModelReferenceDetail config={parsedConfig} reference={reference} onChange={async next => {
        const result = await commitRaw(configToYamlString(next));
        if (!result.ok) throw new Error(result.error);
      }} />
      <RouterSection config={parsedConfig} onChange={onFormChange} />
    </>
  );
}
