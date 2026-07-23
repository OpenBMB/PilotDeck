import { useTranslation } from "react-i18next";
import { FormRow } from "../../../shared/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import {
  buildModelRefOptions,
  ensureModelRefConfigured,
} from "../../agentModel/utils/modelRefs";
import { DEFAULT_TIERS, ROUTER_TIER_KEYS, type RouterTierKey, replaceFallbackModelRef } from "../utils/router";
import { SettingsCard } from "../../../shared/view";
import ModelRefInput from "./ModelRefInput";

type RouterLevelEditorProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function RouterLevelEditor({
  config,
  onChange,
}: RouterLevelEditorProps) {
  const { t } = useTranslation("settings");
  const modelOpts = buildModelRefOptions(config);
  const defaultValue = config.router?.scenarios?.default ?? "";
  const judgeValue = config.router?.tokenSaver?.judge ?? "";
  const tiers = config.router?.tokenSaver?.tiers ?? {};

  const setDefault = (value: string) => {
    let next = patch(
      ensureModelRefConfigured(config, value),
      ["router", "scenarios", "default"],
      value,
    );
    next = replaceFallbackModelRef(next, defaultValue, value);
    const fallbackDefault = config.router?.fallback?.default ?? [];
    if (
      fallbackDefault.length === 0 ||
      (fallbackDefault.length === 1 && fallbackDefault[0] === defaultValue)
    ) {
      next = patch(next, ["router", "fallback", "default"], value ? [value] : []);
    }
    onChange(next);
  };

  const setTierModel = (key: RouterTierKey, model: string) => {
    const existing = tiers[key] ?? {};
    onChange(
      patch(ensureModelRefConfigured(config, model), ["router", "tokenSaver", "tiers", key], {
        ...existing,
        model,
        description: existing.description ?? DEFAULT_TIERS[key].description,
      }),
    );
  };

  const setJudgeModel = (value: string) => {
    onChange(
      patch(ensureModelRefConfigured(config, value), ["router", "tokenSaver", "judge"], value),
    );
  };

  return (
    <SettingsCard divided>
      <FormRow
        label={t("pilotDeckConfig.panels.router.levels.default.label")}
        description={t("pilotDeckConfig.panels.router.levels.default.description")}
      >
        <ModelRefInput
          value={defaultValue}
          options={modelOpts}
          placeholder={t("pilotDeckConfig.panels.router.levels.modelPlaceholder")}
          onChange={setDefault}
        />
      </FormRow>

      <FormRow
        label={t("pilotDeckConfig.panels.router.levels.judge.label")}
        description={t("pilotDeckConfig.panels.router.levels.judge.description")}
      >
        <ModelRefInput
          value={judgeValue}
          options={modelOpts}
          placeholder={t("pilotDeckConfig.panels.router.levels.modelPlaceholder")}
          onChange={setJudgeModel}
        />
      </FormRow>

      {ROUTER_TIER_KEYS.map((key) => (
        <FormRow
          key={key}
          label={t(`pilotDeckConfig.panels.router.levels.${key}.label`)}
          description={t(`pilotDeckConfig.panels.router.levels.${key}.description`)}
        >
          <ModelRefInput
            value={tiers[key]?.model ?? ""}
            options={modelOpts}
            placeholder={t("pilotDeckConfig.panels.router.levels.modelPlaceholder")}
            onChange={(v) => setTierModel(key, v)}
          />
        </FormRow>
      ))}
    </SettingsCard>
  );
}
