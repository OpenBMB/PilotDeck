import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { FieldSaveModeProvider } from "../../shared/components/Inputs";
import type { PilotDeckConfig } from "./types";
import { configToYamlString, safeParseYaml } from "./utils/configYaml";
import ModelsSection from "./components/ModelsSection";

type ModelPoolSectionsProps = {
  title: string;
};

export default function ModelPoolSections({ title }: ModelPoolSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = async (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      await save();
    } catch (caught) {
      console.error("Failed to serialise model pool config patch", caught);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsNew.invalidYaml.modelPool")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      {parsedConfig ? (
        <FieldSaveModeProvider mode="immediate">
          <ModelsSection config={parsedConfig} onChange={onFormChange} />
        </FieldSaveModeProvider>
      ) : null}
    </div>
  );
}
