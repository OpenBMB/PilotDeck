import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  usePilotDeckConfig,
  type ConfigSaveOptions,
  type ConfigSaveResult,
} from "../../../../hooks/usePilotDeckConfig";
import { FieldSaveModeProvider } from "../../shared/components/Inputs";
import { ConfigSaveError } from "../../shared/view";
import type { PilotDeckConfig } from "./types";
import { configToYamlString, safeParseYaml } from "./utils/configYaml";
import ModelsSection from "./components/ModelsSection";

type ModelPoolSectionsProps = {
  title: string;
};

export default function ModelPoolSections({ title: _title }: ModelPoolSectionsProps) {
  const { t } = useTranslation("settings");
  const {
    raw,
    commitRaw,
    loading,
    error,
  } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = async (
    next: PilotDeckConfig,
    options?: ConfigSaveOptions,
  ): Promise<ConfigSaveResult> => {
    try {
      const nextRaw = configToYamlString(next);
      return await commitRaw(nextRaw, options);
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : "Failed to serialise model pool config patch";
      console.error("Failed to serialise model pool config patch", caught);
      return { ok: false, error: message };
    }
  };

  if (loading) {
    return (
      <div className="model-pool-page-content">
        <div className="provider-empty">{t("pilotDeckConfig.loading")}</div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="model-pool-page-content">
        <div className="field-error banner">{t("settingsPage.invalidYaml.modelPool")}</div>
      </div>
    );
  }

  return (
    <div className="model-pool-page-content">
      <ConfigSaveError error={error} />
      <FieldSaveModeProvider mode="immediate">
        <ModelsSection config={parsedConfig} onChange={onFormChange} />
      </FieldSaveModeProvider>
    </div>
  );
}
