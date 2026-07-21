import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { PageSectionHeader } from "../../shared/view";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import ServiceSection from "./components/ServiceSection";
import CustomEnvSection from "./components/CustomEnvSection";

type AdvancedSectionsProps = {
  title: string;
};

export default function AdvancedSections({ title }: AdvancedSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise advanced config patch", caught);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      {loading ? (
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      ) : parsedConfig ? (
        <>
          <PageSectionHeader
            title={t("pilotDeckConfig.panels.runtime.title")}
            description={t("pilotDeckConfig.panels.runtime.description")}
          />
          <ServiceSection config={parsedConfig} onChange={onFormChange} />

          <PageSectionHeader
            title={t("pilotDeckConfig.panels.customEnv.title")}
            description={t("pilotDeckConfig.panels.customEnv.description")}
          />
          <CustomEnvSection config={parsedConfig} onChange={onFormChange} />
        </>
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsNew.invalidYaml.advanced")}
        </div>
      )}
    </div>
  );
}
