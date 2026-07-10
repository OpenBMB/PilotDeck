import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Gauge, Image as ImageIcon, Info } from "lucide-react";
import { cn } from "../../../../../lib/utils";
import { PageSectionHeader, SettingsCard } from "../../../shared/view";
import { FormRow, Select } from "../../modelPool/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import {
  activeModelCapabilities,
  buildModelRefOptions,
  ensureModelRefConfigured,
} from "../utils/modelRefs";

type AgentsSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function AgentsSection({ config, onChange }: AgentsSectionProps) {
  const { t } = useTranslation("settings");
  const [showAdvanced, setShowAdvanced] = useState(true);
  const refOptions = buildModelRefOptions(config);
  const mainRef = config.agent?.model ?? "";
  const subDefault = config.agent?.subagents?.default ?? "inherit";

  const mainOptions = [{ value: "", label: "— pick a model —" }, ...refOptions];
  const subOptions = [
    { value: "inherit", label: t("pilotDeckConfig.panels.agents.subagents.inherit") },
    ...refOptions,
  ];

  const caps = activeModelCapabilities(config);
  const supportsImageEffective = caps
    ? caps.multimodalInput
      ? caps.multimodalInput.includes("image")
      : Boolean(caps.catalogModel?.supportsImage)
    : false;
  const userOverrideActive = caps?.multimodalInput != null;

  const setImageOverride = (enable: boolean) => {
    if (!caps) return;
    const { providerId, modelId } = caps;
    const providers = config.model?.providers ?? {};
    const provider = providers[providerId] ?? {};
    const models = { ...(provider.models ?? {}) };
    const existingDef = models[modelId];
    const def: Record<string, unknown> =
      existingDef && typeof existingDef === "object"
        ? { ...(existingDef as Record<string, unknown>) }
        : {};

    const catalogDefault = Boolean(caps.catalogModel?.supportsImage);
    if (enable === catalogDefault) {
      delete def.multimodal;
    } else {
      def.multimodal = { input: enable ? ["text", "image"] : ["text"] };
    }
    models[modelId] = def as Record<string, unknown>;
    onChange(patch(config, ["model", "providers", providerId, "models"], models));
  };

  const setMaxOutputTokens = (value: number | undefined) => {
    if (!caps) return;
    const { providerId, modelId } = caps;
    const providers = config.model?.providers ?? {};
    const provider = providers[providerId] ?? {};
    const models = { ...(provider.models ?? {}) };
    const existingDef = models[modelId];
    const def: Record<string, unknown> =
      existingDef && typeof existingDef === "object"
        ? { ...(existingDef as Record<string, unknown>) }
        : {};
    const capabilities: Record<string, unknown> =
      def.capabilities && typeof def.capabilities === "object"
        ? { ...(def.capabilities as Record<string, unknown>) }
        : {};
    if (value === undefined) {
      delete capabilities.maxOutputTokens;
    } else {
      capabilities.maxOutputTokens = value;
    }
    if (Object.keys(capabilities).length > 0) {
      def.capabilities = capabilities;
    } else {
      delete def.capabilities;
    }
    models[modelId] = def as Record<string, unknown>;
    onChange(patch(config, ["model", "providers", providerId, "models"], models));
  };

  return (
    <div className="space-y-3">
      <PageSectionHeader description={t("pilotDeckConfig.panels.agents.description")} />
      <SettingsCard divided>
        <FormRow
          label={t("pilotDeckConfig.panels.agents.mainModel.label")}
          description={t("pilotDeckConfig.panels.agents.mainModel.description")}
        >
          <Select
            value={mainRef}
            options={mainOptions}
            onChange={(v) =>
              onChange(patch(ensureModelRefConfigured(config, v), ["agent", "model"], v))
            }
          />
        </FormRow>

        {caps && (
          <div className="px-4 py-3">
            <div className="rounded-md border border-border/60 bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-foreground">
                {t("pilotDeckConfig.panels.agents.capabilities.title")}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5" />
                  {t("pilotDeckConfig.panels.agents.capabilities.imageInput")}
                </span>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={supportsImageEffective}
                    onChange={(e) => setImageOverride(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border"
                  />
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      supportsImageEffective
                        ? "border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
                        : "border border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {supportsImageEffective
                      ? t("pilotDeckConfig.panels.agents.capabilities.enabled")
                      : t("pilotDeckConfig.panels.agents.capabilities.disabled")}
                  </span>
                </label>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                {userOverrideActive
                  ? t("pilotDeckConfig.panels.agents.capabilities.overrideActive")
                  : caps.catalogModel
                    ? caps.catalogModel.supportsImage
                      ? t("pilotDeckConfig.panels.agents.capabilities.catalogSupportsImage")
                      : t("pilotDeckConfig.panels.agents.capabilities.catalogTextOnly")
                    : t("pilotDeckConfig.panels.agents.capabilities.noCatalog")}{" "}
                {t("pilotDeckConfig.panels.agents.capabilities.imageWarning")}
              </p>

              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" />
                    {t("pilotDeckConfig.panels.agents.capabilities.maxOutputTokens")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={caps.maxOutputTokensOverride ?? ""}
                    placeholder={String(caps.catalogModel?.maxOutputTokens ?? 16384)}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") return setMaxOutputTokens(undefined);
                      const n = Number(v);
                      if (Number.isFinite(n) && n > 0) {
                        setMaxOutputTokens(Math.floor(n));
                      }
                    }}
                    className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  {t("pilotDeckConfig.panels.agents.capabilities.maxOutputDescription")}
                </p>
              </div>

              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" />
                    {t("pilotDeckConfig.panels.agents.capabilities.maxContextTokens")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={config.agent?.maxContextTokens ?? ""}
                    placeholder={String(caps.catalogModel?.maxContextTokens ?? 200000)}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        const next = { ...(config.agent ?? {}) };
                        delete next.maxContextTokens;
                        onChange(patch(config, ["agent"], next));
                        return;
                      }
                      const n = Number(v);
                      if (Number.isFinite(n) && n > 0) {
                        onChange(patch(config, ["agent", "maxContextTokens"], Math.floor(n)));
                      }
                    }}
                    className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  {t("pilotDeckConfig.panels.agents.capabilities.maxContextDescription")}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="px-4 py-2.5">
          <button
            type="button"
            onClick={() => setShowAdvanced((next) => !next)}
            aria-expanded={showAdvanced}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")}
            />
            {t("pilotDeckConfig.panels.agents.advancedToggle")}
          </button>
        </div>

        {showAdvanced && (
          <div className="divide-y divide-border">
            <FormRow
              label={t("pilotDeckConfig.panels.agents.subagents.label")}
              description={t("pilotDeckConfig.panels.agents.subagents.description")}
            >
              <Select
                value={subDefault}
                options={subOptions}
                onChange={(v) =>
                  onChange(
                    patch(
                      ensureModelRefConfigured(config, v),
                      ["agent", "subagents", "default"],
                      v,
                    ),
                  )
                }
              />
            </FormRow>
            <div className="flex gap-2 px-4 py-3 text-[11px] leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <p>{t("pilotDeckConfig.panels.agents.subagents.routerNote")}</p>
            </div>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
