import { useEffect, useMemo, useState } from "react";
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
import { buildModelRefOptions, ensureModelRefConfigured } from "./utils/modelRefs";
import { patch } from "./utils/patch";
import { GeneralSelectControl, GeneralSettingRow } from "../../shared/view/GeneralSettingsPrimitives";

type ModelPoolSectionsProps = {
  title: string;
};

export default function ModelPoolSections({ title: _title }: ModelPoolSectionsProps) {
  const { t } = useTranslation("settings");
  const {
    raw,
    commitRaw,
    acceptServerConfig,
    loading,
    error,
  } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);
  const [savingModel, setSavingModel] = useState(false);
  const [contextDraft, setContextDraft] = useState("");
  useEffect(() => {
    setContextDraft(String(parsedConfig?.agent?.maxContextTokens ?? ""));
  }, [parsedConfig?.agent?.maxContextTokens]);

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
      <section className="general-card model-pool-default" data-model-reference="agent.model" tabIndex={-1}>
        <GeneralSettingRow
          title={t("pilotDeckConfig.panels.agents.mainModel.label")}
          detail={t("pilotDeckConfig.panels.agents.mainModel.description")}
          htmlFor="pool-main-model"
        >
          <GeneralSelectControl id="pool-main-model" disabled={savingModel}
            value={parsedConfig.agent?.model ?? ""}
            options={[
              ...(!parsedConfig.agent?.model ? [{ value: "", label: "—" }] : []),
              ...buildModelRefOptions(parsedConfig),
            ]}
            onChange={async value => {
              setSavingModel(true);
              try { await onFormChange(patch(ensureModelRefConfigured(parsedConfig, value), ["agent", "model"], value)); }
              finally { setSavingModel(false); }
            }}
          />
        </GeneralSettingRow>
        <GeneralSettingRow title={t("pilotDeckConfig.panels.agents.mainModel.contextLimit")}
          detail={t("pilotDeckConfig.panels.agents.mainModel.contextDescription")} htmlFor="pool-context-limit">
          <div className="general-select-wrap">
            <input id="pool-context-limit" type="number" min="1" step="1"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              placeholder={t("pilotDeckConfig.panels.agents.mainModel.contextDefault")} disabled={savingModel}
              value={contextDraft} onChange={event => setContextDraft(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
              onBlur={async event => {
                if (!event.currentTarget.checkValidity()) { event.currentTarget.reportValidity(); return; }
                const value = contextDraft.trim() ? Number(contextDraft) : undefined;
                if (value !== undefined && !Number.isSafeInteger(value)) return;
                if (value === parsedConfig.agent?.maxContextTokens) return;
                const agent = { ...parsedConfig.agent };
                if (value === undefined) delete agent.maxContextTokens;
                else agent.maxContextTokens = value;
                setSavingModel(true);
                try { await onFormChange(patch(parsedConfig, ["agent"], agent)); }
                finally { setSavingModel(false); }
              }} />
          </div>
        </GeneralSettingRow>
      </section>
      <FieldSaveModeProvider mode="immediate">
        <ModelsSection config={parsedConfig} onChange={onFormChange} onServerConfig={acceptServerConfig} />
      </FieldSaveModeProvider>
    </div>
  );
}
