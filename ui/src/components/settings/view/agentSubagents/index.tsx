import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import ProfilesSection from "./components/ProfilesSection";

type AgentSubagentsSectionsProps = {
  title: string;
};

export default function AgentSubagentsSections({ title: _title }: AgentSubagentsSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, commitRaw, loading, saving } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onSave = async (next: PilotDeckConfig) => {
    try {
      const result = await commitRaw(configToYamlString(next));
      if (result && result.ok === false) {
        return { ok: false as const, error: result.error };
      }
      return { ok: true as const };
    } catch (caught) {
      return {
        ok: false as const,
        error: caught instanceof Error
          ? caught.message
          : t("pilotDeckConfig.panels.agentSubagents.saveFailed"),
      };
    }
  };

  if (loading) {
    return (
      <div className="py-6 text-xs text-muted-foreground">
        {t("pilotDeckConfig.loading")}
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        {t("settingsPage.invalidYaml.agentSubagents")}
      </div>
    );
  }

  return <ProfilesSection config={parsedConfig} saving={saving} onSave={onSave} />;
}
