import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../../../lib/utils";
import { FormRow, NumberInput, Select } from "../../../shared/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import {
  buildModelRefOptions,
  ensureModelRefConfigured,
} from "../../agentModel/utils/modelRefs";
import {
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "../../../shared/view";
import {
  DEFAULT_RULES,
  DEFAULT_TIERS,
  ROUTER_TIER_KEYS,
} from "../utils/router";
import ModelPricingEditor from "./ModelPricingEditor";
import RouterFallbackEditor from "./RouterFallbackEditor";
import RouterLevelEditor from "./RouterLevelEditor";
import TokenSaverRulesEditor from "./TokenSaverRulesEditor";
import TokenSaverTierEditor from "./TokenSaverTierEditor";

type RouterSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function RouterSection({ config, onChange }: RouterSectionProps) {
  const { t } = useTranslation("settings");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const r = config.router ?? {};
  const enabled = r.enabled !== false;
  const modelOpts = buildModelRefOptions(config);

  const ts = r.tokenSaver ?? {};
  const ao = r.autoOrchestrate ?? {};
  const zr = r.zeroUsageRetry ?? {};
  const tr = r.transientRetry ?? {};
  const statsEnabled = r.stats?.enabled !== false;
  const zeroUsageEnabled = zr.enabled !== false;
  const transientRetryEnabled = tr.enabled !== false;
  const tokenSaverEnabled = ts.enabled !== false;
  const autoOrchestrateEnabled = ao.enabled !== false;
  const availableTierNames = Object.keys(ts.tiers ?? {});

  const getDefaultModel = (base: PilotDeckConfig) =>
    (typeof base.router?.scenarios?.default === "string" &&
      base.router.scenarios.default.trim()) ||
    (typeof base.agent?.model === "string" && base.agent.model.trim()) ||
    modelOpts[0]?.value ||
    "";

  const seedRouterDefaults = (base: PilotDeckConfig) => {
    let next = base;
    const defaultModel = getDefaultModel(next);
    next = ensureModelRefConfigured(next, defaultModel);

    if (defaultModel && !next.router?.scenarios?.default) {
      next = patch(next, ["router", "scenarios", "default"], defaultModel);
    }
    if (defaultModel && !(next.router?.fallback?.default?.length)) {
      next = patch(next, ["router", "fallback", "default"], [defaultModel]);
    }
    if (next.router?.zeroUsageRetry?.enabled !== true) {
      next = patch(next, ["router", "zeroUsageRetry", "enabled"], true);
    }
    if (next.router?.zeroUsageRetry?.maxAttempts == null) {
      next = patch(next, ["router", "zeroUsageRetry", "maxAttempts"], 2);
    }
    if (next.router?.transientRetry?.enabled !== true) {
      next = patch(next, ["router", "transientRetry", "enabled"], true);
    }
    if (next.router?.transientRetry?.maxAttempts == null) {
      next = patch(next, ["router", "transientRetry", "maxAttempts"], 5);
    }
    if (next.router?.tokenSaver?.enabled !== true) {
      next = patch(next, ["router", "tokenSaver", "enabled"], true);
    }
    if (defaultModel && !next.router?.tokenSaver?.judge) {
      next = patch(next, ["router", "tokenSaver", "judge"], defaultModel);
    }
    if (!next.router?.tokenSaver?.defaultTier) {
      next = patch(next, ["router", "tokenSaver", "defaultTier"], "medium");
    }
    if (!next.router?.tokenSaver?.judgeTimeoutMs) {
      next = patch(next, ["router", "tokenSaver", "judgeTimeoutMs"], 15000);
    }
    for (const key of ROUTER_TIER_KEYS) {
      const existing = next.router?.tokenSaver?.tiers?.[key] ?? {};
      if (!existing.model || !existing.description) {
        next = patch(next, ["router", "tokenSaver", "tiers", key], {
          ...existing,
          model: existing.model ?? defaultModel,
          description: existing.description ?? DEFAULT_TIERS[key].description,
        });
      }
    }
    if ((next.router?.tokenSaver?.rules ?? []).length === 0) {
      next = patch(next, ["router", "tokenSaver", "rules"], [...DEFAULT_RULES]);
    }
    if (next.router?.autoOrchestrate?.enabled !== true) {
      next = patch(next, ["router", "autoOrchestrate", "enabled"], true);
    }
    if ((next.router?.autoOrchestrate?.triggerTiers ?? []).length === 0) {
      next = patch(next, ["router", "autoOrchestrate", "triggerTiers"], ["complex"]);
    }
    if (next.router?.autoOrchestrate?.slimSystemPrompt == null) {
      next = patch(next, ["router", "autoOrchestrate", "slimSystemPrompt"], true);
    }
    if (next.router?.stats?.enabled !== true) {
      next = patch(next, ["router", "stats", "enabled"], true);
    }

    return next;
  };

  return (
    <div className="space-y-4 pb-6">
      <PageSectionHeader description={t("pilotDeckConfig.panels.router.description")} />
      <SettingsCard divided>
        <SettingsRow
          label={t("pilotDeckConfig.panels.router.enabled.label")}
          description={t("pilotDeckConfig.panels.router.enabled.description")}
        >
          <SettingsToggle
            checked={enabled}
            ariaLabel={t("pilotDeckConfig.panels.router.enabled.label")}
            onChange={(v) => {
              let next = patch(config, ["router", "enabled"], v);
              if (v) next = seedRouterDefaults(next);
              onChange(next);
            }}
          />
        </SettingsRow>
      </SettingsCard>

      {enabled && (
        <>
          <RouterLevelEditor config={config} onChange={onChange} />

          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            aria-expanded={showAdvanced}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")}
            />
            {t("pilotDeckConfig.panels.router.advancedToggle")}
          </button>

          {showAdvanced && (
            <>
              <RouterFallbackEditor config={config} onChange={onChange} />

              <SettingsCard divided>
                <SettingsRow
                  label={t("pilotDeckConfig.panels.router.zeroUsageRetry.label")}
                  description={t("pilotDeckConfig.panels.router.zeroUsageRetry.description")}
                >
                  <SettingsToggle
                    checked={zeroUsageEnabled}
                    ariaLabel={t("pilotDeckConfig.panels.router.zeroUsageRetry.label")}
                    onChange={(v) =>
                      onChange(patch(config, ["router", "zeroUsageRetry", "enabled"], v))
                    }
                  />
                </SettingsRow>
                {zeroUsageEnabled && (
                  <FormRow
                    label={t("pilotDeckConfig.panels.router.zeroUsageRetry.maxAttempts.label")}
                    description={t(
                      "pilotDeckConfig.panels.router.zeroUsageRetry.maxAttempts.description",
                    )}
                  >
                    <NumberInput
                      value={zr.maxAttempts}
                      placeholder="2"
                      onChange={(v) =>
                        onChange(patch(config, ["router", "zeroUsageRetry", "maxAttempts"], v))
                      }
                    />
                  </FormRow>
                )}
              </SettingsCard>

              <SettingsCard className="space-y-4 p-4">
                <SettingsRow
                  label={t("pilotDeckConfig.panels.router.transientRetry.label")}
                  description={t("pilotDeckConfig.panels.router.transientRetry.description")}
                >
                  <SettingsToggle
                    checked={transientRetryEnabled}
                    onChange={(v) =>
                      onChange(patch(config, ["router", "transientRetry", "enabled"], v))
                    }
                    ariaLabel={t("pilotDeckConfig.panels.router.transientRetry.label")}
                  />
                </SettingsRow>
                {transientRetryEnabled && (
                  <>
                    <FormRow
                      label={t("pilotDeckConfig.panels.router.transientRetry.maxAttempts.label")}
                      description={t(
                        "pilotDeckConfig.panels.router.transientRetry.maxAttempts.description",
                      )}
                    >
                      <NumberInput
                        value={tr.maxAttempts}
                        placeholder="5"
                        onChange={(v) =>
                          onChange(patch(config, ["router", "transientRetry", "maxAttempts"], v))
                        }
                      />
                    </FormRow>
                    <FormRow
                      label={t("pilotDeckConfig.panels.router.transientRetry.baseDelayMs.label")}
                      description={t(
                        "pilotDeckConfig.panels.router.transientRetry.baseDelayMs.description",
                      )}
                    >
                      <NumberInput
                        value={tr.baseDelayMs}
                        placeholder="1000"
                        onChange={(v) =>
                          onChange(patch(config, ["router", "transientRetry", "baseDelayMs"], v))
                        }
                      />
                    </FormRow>
                    <FormRow
                      label={t("pilotDeckConfig.panels.router.transientRetry.maxDelayMs.label")}
                      description={t(
                        "pilotDeckConfig.panels.router.transientRetry.maxDelayMs.description",
                      )}
                    >
                      <NumberInput
                        value={tr.maxDelayMs}
                        placeholder="30000"
                        onChange={(v) =>
                          onChange(patch(config, ["router", "transientRetry", "maxDelayMs"], v))
                        }
                      />
                    </FormRow>
                  </>
                )}
              </SettingsCard>

              <SettingsCard className="space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {t("pilotDeckConfig.panels.router.tokenSaver.title")}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("pilotDeckConfig.panels.router.tokenSaver.description")}
                    </div>
                  </div>
                  <SettingsToggle
                    checked={tokenSaverEnabled}
                    ariaLabel={t("pilotDeckConfig.panels.router.tokenSaver.title")}
                    onChange={(v) => {
                      let next = patch(config, ["router", "tokenSaver", "enabled"], v);
                      if (v) next = seedRouterDefaults(next);
                      onChange(next);
                    }}
                  />
                </div>

                {tokenSaverEnabled && (
                  <div className="space-y-4 border-t border-border pt-4">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-foreground">
                        {t("pilotDeckConfig.panels.router.tokenSaver.defaultTier")}
                      </label>
                      <Select
                        value={ts.defaultTier ?? "medium"}
                        options={
                          availableTierNames.length > 0
                            ? availableTierNames.map((tier) => ({
                                value: tier,
                                label: tier,
                              }))
                            : ROUTER_TIER_KEYS.map((tier) => ({
                                value: tier,
                                label: tier,
                              }))
                        }
                        onChange={(v) =>
                          onChange(patch(config, ["router", "tokenSaver", "defaultTier"], v))
                        }
                      />
                    </div>
                    <FormRow
                      label={t("pilotDeckConfig.panels.router.tokenSaver.judgeTimeout.label")}
                      description={t(
                        "pilotDeckConfig.panels.router.tokenSaver.judgeTimeout.description",
                      )}
                    >
                      <NumberInput
                        value={ts.judgeTimeoutMs}
                        placeholder="15000"
                        onChange={(v) =>
                          onChange(patch(config, ["router", "tokenSaver", "judgeTimeoutMs"], v))
                        }
                      />
                    </FormRow>
                    <FormRow
                      label={t("pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.label")}
                      description={t(
                        "pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.description",
                      )}
                    >
                      <Select
                        value={ts.subagent?.policy ?? "judge"}
                        options={[
                          { value: "judge", label: "judge" },
                          { value: "skip", label: "skip" },
                        ]}
                        onChange={(v) =>
                          onChange(
                            patch(config, ["router", "tokenSaver", "subagent", "policy"], v),
                          )
                        }
                      />
                    </FormRow>

                    <TokenSaverTierEditor config={config} onChange={onChange} />
                    <TokenSaverRulesEditor config={config} onChange={onChange} />
                  </div>
                )}
              </SettingsCard>

              <SettingsCard className="space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {t("pilotDeckConfig.panels.router.autoOrchestrate.title")}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("pilotDeckConfig.panels.router.autoOrchestrate.description")}
                    </div>
                  </div>
                  <SettingsToggle
                    checked={autoOrchestrateEnabled}
                    ariaLabel={t("pilotDeckConfig.panels.router.autoOrchestrate.title")}
                    onChange={(v) =>
                      onChange(patch(config, ["router", "autoOrchestrate", "enabled"], v))
                    }
                  />
                </div>

                {autoOrchestrateEnabled && (
                  <div className="space-y-3 border-t border-border pt-4">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-foreground">
                        {t("pilotDeckConfig.panels.router.autoOrchestrate.triggerTiers")}
                      </label>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {(availableTierNames.length > 0
                          ? availableTierNames
                          : [...ROUTER_TIER_KEYS]
                        ).map((tier) => {
                          const active = (ao.triggerTiers ?? ["complex"]).includes(tier);
                          return (
                            <button
                              key={tier}
                              type="button"
                              className={cn(
                                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                                active
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border bg-background text-muted-foreground hover:bg-muted",
                              )}
                              onClick={() => {
                                const prev = ao.triggerTiers ?? ["complex"];
                                const next = active
                                  ? prev.filter((value) => value !== tier)
                                  : [...prev, tier];
                                onChange(
                                  patch(config, ["router", "autoOrchestrate", "triggerTiers"], next),
                                );
                              }}
                            >
                              {tier}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <SettingsRow
                      label={t("pilotDeckConfig.panels.router.autoOrchestrate.slimPrompt.label")}
                      description={t(
                        "pilotDeckConfig.panels.router.autoOrchestrate.slimPrompt.description",
                      )}
                    >
                      <SettingsToggle
                        checked={ao.slimSystemPrompt !== false}
                        ariaLabel={t(
                          "pilotDeckConfig.panels.router.autoOrchestrate.slimPrompt.label",
                        )}
                        onChange={(v) =>
                          onChange(patch(config, ["router", "autoOrchestrate", "slimSystemPrompt"], v))
                        }
                      />
                    </SettingsRow>
                  </div>
                )}
              </SettingsCard>

              <SettingsCard divided>
                <SettingsRow
                  label={t("pilotDeckConfig.panels.router.stats.label")}
                  description={t("pilotDeckConfig.panels.router.stats.description")}
                >
                  <SettingsToggle
                    checked={statsEnabled}
                    ariaLabel={t("pilotDeckConfig.panels.router.stats.label")}
                    onChange={(v) => onChange(patch(config, ["router", "stats", "enabled"], v))}
                  />
                </SettingsRow>
              </SettingsCard>

              {statsEnabled && <ModelPricingEditor config={config} onChange={onChange} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
