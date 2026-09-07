import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ListOrdered,
  Plus,
  Route,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import {
  buildModelRefOptions,
  ensureModelRefConfigured,
} from "../../agentModel/utils/modelRefs";
import { findCatalogProviderById } from "../../../../../shared/catalogProviders";
import {
  queueSettingsSaveSuccess,
  showSettingsSuccess,
} from "../../../shared/SettingsSuccessToast";
import {
  DEFAULT_RULES,
  DEFAULT_TIERS,
  getBuiltInPricing,
  ROUTER_TIER_KEYS,
} from "../utils/router";

type RouterSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

type TierMap = Record<
  string,
  { model?: string; label?: string; description?: string }
>;

const EMPTY_TIERS: TierMap = {};

function SubagentIcon() {
  return (
    <svg width="18" height="18" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
      <path
        d="M200,56H56A24,24,0,0,0,32,80V192a24,24,0,0,0,24,24H200a24,24,0,0,0,24-24V80A24,24,0,0,0,200,56ZM164,184H92a20,20,0,0,1,0-40h72a20,20,0,0,1,0,40Z"
        opacity="0.2"
      />
      <path d="M200,48H136V16a8,8,0,0,0-16,0V48H56A32,32,0,0,0,24,80V192a32,32,0,0,0,32,32H200a32,32,0,0,0,32-32V80A32,32,0,0,0,200,48Zm16,144a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V80A16,16,0,0,1,56,64H200a16,16,0,0,1,16,16ZM72,108a12,12,0,1,1,12,12A12,12,0,0,1,72,108Zm88,0a12,12,0,1,1,12,12A12,12,0,0,1,160,108Zm4,28H92a28,28,0,0,0,0,56h72a28,28,0,0,0,0-56Zm-24,16v24H116V152ZM80,164a12,12,0,0,1,12-12h8v24H92A12,12,0,0,1,80,164Zm84,12h-8V152h8a12,12,0,0,1,0,24Z" />
    </svg>
  );
}

function ModelPricingIcon() {
  return (
    <svg width="18" height="18" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
      <path
        d="M240,132c0,19.88-35.82,36-80,36-19.6,0-37.56-3.17-51.47-8.44h0C146.76,156.85,176,142,176,124V96.72h0C212.52,100.06,240,114.58,240,132ZM176,84c0-19.88-35.82-36-80-36S16,64.12,16,84s35.82,36,80,36S176,103.88,176,84Z"
        opacity="0.2"
      />
      <path d="M184,89.57V84c0-25.08-37.83-44-88-44S8,58.92,8,84v40c0,20.89,26.25,37.49,64,42.46V172c0,25.08,37.83,44,88,44s88-18.92,88-44V132C248,111.3,222.58,94.68,184,89.57ZM232,132c0,13.22-30.79,28-72,28-3.73,0-7.43-.13-11.08-.37C170.49,151.77,184,139,184,124V105.74C213.87,110.19,232,122.27,232,132ZM72,150.25V126.46A183.74,183.74,0,0,0,96,128a183.74,183.74,0,0,0,24-1.54v23.79A163,163,0,0,1,96,152,163,163,0,0,1,72,150.25Zm96-40.32V124c0,8.39-12.41,17.4-32,22.87V123.5C148.91,120.37,159.84,115.71,168,109.93ZM96,56c41.21,0,72,14.78,72,28s-30.79,28-72,28S24,97.22,24,84,54.79,56,96,56ZM24,124V109.93c8.16,5.78,19.09,10.44,32,13.57v23.37C36.41,141.4,24,132.39,24,124Zm64,48v-4.17c2.63.1,5.29.17,8,.17,3.88,0,7.67-.13,11.39-.35A121.92,121.92,0,0,0,120,171.41v23.46C100.41,189.4,88,180.39,88,172Zm48,26.25V174.4a179.48,179.48,0,0,0,24,1.6,183.74,183.74,0,0,0,24-1.54v23.79a165.45,165.45,0,0,1-48,0Zm64-3.38V171.5c12.91-3.13,23.84-7.79,32-13.57V172C232,180.39,219.59,189.4,200,194.87Z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z" />
    </svg>
  );
}

export default function RouterSection({
  config,
  onChange,
}: RouterSectionProps) {
  const { t } = useTranslation("settings");
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [editingTiers, setEditingTiers] = useState(false);
  const [editingPricing, setEditingPricing] = useState(false);
  const r = config.router ?? {};
  const enabled = r.enabled === true;
  const modelOpts = buildModelRefOptions(config);
  const tiers = r.tokenSaver?.tiers ?? EMPTY_TIERS;
  const defaultTier = r.tokenSaver?.defaultTier ?? "medium";
  const subagentPolicy = r.tokenSaver?.subagent?.policy ?? "judge";
  const fallbackModel =
    r.scenarios?.default || config.agent?.model || modelOpts[0]?.value || "";
  const [tierDraft, setTierDraft] = useState(tiers);
  const [pricingDraft, setPricingDraft] = useState(r.stats?.modelPricing ?? {});

  useEffect(() => {
    if (!editingTiers) setTierDraft(tiers);
  }, [editingTiers, tiers]);

  useEffect(() => {
    if (!editingPricing) setPricingDraft(r.stats?.modelPricing ?? {});
  }, [editingPricing, r.stats?.modelPricing]);

  const groupedModels = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; options: Array<{ value: string; label: string }> }
    >();
    for (const option of modelOpts) {
      const slash = option.value.indexOf("/");
      const provider =
        slash > 0
          ? option.value.slice(0, slash)
          : t("pilotDeckConfig.panels.router.ui.otherProvider");
      const catalogProvider = findCatalogProviderById(provider);
      const providerLabel =
        catalogProvider?.displayName ??
        `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
      const separator = option.label.indexOf(": ");
      const modelLabel =
        separator >= 0
          ? option.label.slice(separator + 2)
          : option.label.startsWith(`${provider}/`)
            ? option.label.slice(provider.length + 1)
            : option.label;
      const group = groups.get(provider) ?? {
        label: providerLabel,
        options: [],
      };
      group.options.push({
        ...option,
        label: `${provider}/${modelLabel}`,
      });
      groups.set(provider, group);
    }
    return [...groups.entries()];
  }, [modelOpts, t]);

  const pricingRows = useMemo(() => {
    const labels = new Map(
      modelOpts.map((item) => [item.value, item.label.replace(":", " · ")]),
    );
    for (const key of Object.keys(r.stats?.modelPricing ?? {})) {
      if (!labels.has(key)) labels.set(key, key);
    }
    return [...labels].map(([ref, label]) => ({ ref, label }));
  }, [modelOpts, r.stats?.modelPricing]);

  const seedRouterDefaults = (base: PilotDeckConfig) => {
    const model =
      base.router?.scenarios?.default ||
      base.agent?.model ||
      modelOpts[0]?.value ||
      "";
    let next = ensureModelRefConfigured(base, model);
    next = patch(next, ["router", "enabled"], true);
    next = patch(next, ["router", "scenarios", "default"], model);
    next = patch(next, ["router", "tokenSaver", "enabled"], true);
    next = patch(
      next,
      ["router", "tokenSaver", "judge"],
      base.router?.tokenSaver?.judge || model,
    );
    next = patch(
      next,
      ["router", "tokenSaver", "defaultTier"],
      base.router?.tokenSaver?.defaultTier || "medium",
    );
    next = patch(
      next,
      ["router", "tokenSaver", "judgeTimeoutMs"],
      base.router?.tokenSaver?.judgeTimeoutMs || 15000,
    );
    next = patch(
      next,
      ["router", "tokenSaver", "subagent", "policy"],
      subagentPolicy,
    );
    next = patch(
      next,
      ["router", "tokenSaver", "rules"],
      base.router?.tokenSaver?.rules?.length
        ? base.router.tokenSaver.rules
        : [...DEFAULT_RULES],
    );
    for (const key of ROUTER_TIER_KEYS) {
      const current = base.router?.tokenSaver?.tiers?.[key] ?? {};
      next = patch(next, ["router", "tokenSaver", "tiers", key], {
        ...current,
        model: current.model || model,
        label: current.label || DEFAULT_TIERS[key].label,
        description: current.description || DEFAULT_TIERS[key].description,
      });
    }
    next = patch(next, ["router", "stats", "enabled"], true);
    next = patch(
      next,
      ["router", "autoOrchestrate", "enabled"],
      base.router?.autoOrchestrate?.enabled ?? true,
    );
    next = patch(
      next,
      ["router", "autoOrchestrate", "triggerTiers"],
      base.router?.autoOrchestrate?.triggerTiers?.length
        ? base.router.autoOrchestrate.triggerTiers
        : ["complex"],
    );
    next = patch(
      next,
      ["router", "autoOrchestrate", "slimSystemPrompt"],
      base.router?.autoOrchestrate?.slimSystemPrompt ?? true,
    );
    return next;
  };

  const updateModel = (path: string[], value: string) => {
    onChange(patch(ensureModelRefConfigured(config, value), path, value));
  };

  const saveTierDefinitions = () => {
    const normalized = Object.fromEntries(
      Object.entries(tierDraft).map(([key, tier]) => [
        key,
        {
          ...tier,
          model: tier.model || fallbackModel,
          label: tier.label?.trim() || key,
          description: tier.description?.trim() || "",
        },
      ]),
    );
    let next = patch(config, ["router", "tokenSaver", "tiers"], normalized);
    if (!normalized[defaultTier]) {
      next = patch(
        next,
        ["router", "tokenSaver", "defaultTier"],
        Object.keys(normalized)[0] || "medium",
      );
    }
    setEditingTiers(false);
    queueSettingsSaveSuccess(
      t("pilotDeckConfig.panels.router.ui.tierDefinitionsSaved"),
    );
    onChange(next);
  };

  const savePricing = () => {
    const normalized = Object.fromEntries(
      pricingRows.flatMap(({ ref }) => {
        const builtIn = getBuiltInPricing(ref);
        const draft = pricingDraft[ref] ?? builtIn ?? {};
        const hasValue = ["input", "output", "cacheRead"].some(
          (field) => typeof draft[field as keyof typeof draft] === "number",
        );
        return hasValue
          ? [[ref, { ...draft, unit: draft.unit ?? "$/百万 Token" }]]
          : [];
      }),
    );
    setEditingPricing(false);
    queueSettingsSaveSuccess(
      t("pilotDeckConfig.panels.router.ui.pricingSaved"),
    );
    onChange(patch(config, ["router", "stats", "modelPricing"], normalized));
  };

  const renderModelSelect = (
    value: string,
    ariaLabel: string,
    onSelect: (value: string) => void,
    includeInherit = false,
  ) => (
    <div className="route-select-wrap">
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => {
          queueSettingsSaveSuccess(
            t("pilotDeckConfig.panels.router.ui.modelChanged", {
              label: ariaLabel,
              value:
                event.target.selectedOptions[0]?.text || event.target.value,
            }),
          );
          onSelect(event.target.value);
        }}
      >
        {!value ? (
          <option value="">
            {t("pilotDeckConfig.panels.router.ui.selectModel")}
          </option>
        ) : null}
        {includeInherit ? (
          <option value="inherit">
            {t("pilotDeckConfig.panels.router.ui.inheritMainModel")}
          </option>
        ) : null}
        {groupedModels.map(([provider, group]) => (
          <optgroup key={provider} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </div>
  );

  return (
    <div className="route-page-content">
      <section className="route-card route-enable-card">
        <div className="route-card-heading">
          <span className="route-heading-icon">
            <Route size={20} />
          </span>
          <h2>{t("pilotDeckConfig.panels.router.ui.smartRouting")}</h2>
        </div>
        <button
          className={`route-switch${enabled ? " on" : ""}`}
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("pilotDeckConfig.panels.router.ui.smartRouting")}
          onClick={() => {
            const nextEnabled = !enabled;
            queueSettingsSaveSuccess(
              t(
                nextEnabled
                  ? "pilotDeckConfig.panels.router.ui.routingEnabled"
                  : "pilotDeckConfig.panels.router.ui.routingDisabled",
              ),
            );
            onChange(
              enabled
                ? patch(config, ["router", "enabled"], false)
                : seedRouterDefaults(config),
            );
          }}
        >
          <span />
        </button>
      </section>

      {!enabled ? (
        <section className="route-card route-subagent-model-card">
          <div className="route-subagent-model-setting">
            <div className="route-subagent-model-copy">
              <label>
                {t("pilotDeckConfig.panels.router.ui.subagentModel")}
              </label>
              <p>
                {t(
                  "pilotDeckConfig.panels.router.ui.subagentModelDescription",
                )}
              </p>
            </div>
            {renderModelSelect(
              config.agent?.subagents?.default ??
                config.agent?.model ??
                modelOpts[0]?.value ??
                "",
              t("pilotDeckConfig.panels.router.ui.subagentModel"),
              (value) => updateModel(["agent", "subagents", "default"], value),
              true,
            )}
          </div>
        </section>
      ) : (
        <fieldset
          className="route-config-stack"
          aria-label={t("pilotDeckConfig.panels.router.ui.routingConfig")}
        >
          <section className="route-card route-models-card">
            <header className="route-section-header">
              <h2>{t("pilotDeckConfig.panels.router.ui.routingModels")}</h2>
            </header>
            <div className="route-model-list">
              <div className="route-model-row judge-row">
                <div className="route-model-copy">
                  <span className="route-row-icon">
                    <ListOrdered size={18} />
                  </span>
                  <div>
                    <div className="route-label-line">
                      <strong>
                        {t(
                          "pilotDeckConfig.panels.router.levels.judge.label",
                        )}
                      </strong>
                      <span>Judge</span>
                    </div>
                    <p>
                      {t(
                        "pilotDeckConfig.panels.router.levels.judge.description",
                      )}
                    </p>
                  </div>
                </div>
                {renderModelSelect(
                  r.tokenSaver?.judge ?? fallbackModel,
                  t("pilotDeckConfig.panels.router.levels.judge.label"),
                  (value) =>
                    updateModel(["router", "tokenSaver", "judge"], value),
                )}
              </div>
              {Object.entries(tiers).map(([key, tier], index) => {
                const preset = DEFAULT_TIERS[key as keyof typeof DEFAULT_TIERS];
                const usesPresetLabel =
                  preset && (!tier.label || tier.label === preset.label);
                const label = usesPresetLabel
                  ? t(`pilotDeckConfig.panels.router.levels.${key}.label`)
                  : tier.label || key;
                return (
                  <div
                    key={key}
                    className={`route-model-row${defaultTier === key ? " is-default-tier" : ""}`}
                  >
                    <div className="route-model-copy">
                      <span
                        className={`route-tier-index tone-${(index % 4) + 1}`}
                      >
                        {index + 1}
                      </span>
                      <div>
                        <div className="route-label-line">
                          <strong>{label}</strong>
                          <span>{preset?.alias || key}</span>
                          {defaultTier === key ? (
                            <span className="route-default-badge">
                              {t(
                                "pilotDeckConfig.panels.router.ui.defaultBadge",
                              )}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="route-default-action"
                              onClick={() => {
                                queueSettingsSaveSuccess(
                                  t(
                                    "pilotDeckConfig.panels.router.ui.defaultTierChanged",
                                    { label },
                                  ),
                                );
                                onChange(
                                  patch(
                                    config,
                                    ["router", "tokenSaver", "defaultTier"],
                                    key,
                                  ),
                                );
                              }}
                            >
                              {t(
                                "pilotDeckConfig.panels.router.ui.setDefault",
                              )}
                            </button>
                          )}
                        </div>
                        <p>
                          {preset &&
                          (!tier.description ||
                            tier.description === preset.description)
                            ? t(
                                `pilotDeckConfig.panels.router.levels.${key}.description`,
                              )
                            : tier.description ||
                              t(
                                "pilotDeckConfig.panels.router.ui.customTierDescription",
                              )}
                        </p>
                      </div>
                    </div>
                    {renderModelSelect(
                      tier.model ?? fallbackModel,
                      t("pilotDeckConfig.panels.router.ui.modelSuffix", {
                        label,
                      }),
                      (value) =>
                        updateModel(
                          ["router", "tokenSaver", "tiers", key, "model"],
                          value,
                        ),
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="advanced-route-section">
            <button
              className="advanced-route-toggle"
              type="button"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              <span>
                <SlidersHorizontal size={18} />{" "}
                {t("pilotDeckConfig.panels.router.advancedToggle")}
              </span>
              <ChevronDown size={16} className={showAdvanced ? "open" : ""} />
            </button>
            {showAdvanced ? (
              <div className="advanced-route-grid">
                <section className="route-card advanced-route-card advanced-strategy-card">
                  <div className="advanced-strategy-row">
                    <span className="advanced-strategy-title">
                      <SubagentIcon />
                      <span>
                        {t(
                          "pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.label",
                        )}
                      </span>
                    </span>
                    <select
                      aria-label={t(
                        "pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.label",
                      )}
                      value={subagentPolicy}
                      onChange={(event) => {
                        queueSettingsSaveSuccess(
                          t(
                            "pilotDeckConfig.panels.router.ui.modelChanged",
                            {
                              label: t(
                                "pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.label",
                              ),
                              value: event.target.value,
                            },
                          ),
                        );
                        onChange(
                          patch(
                            config,
                            ["router", "tokenSaver", "subagent", "policy"],
                            event.target.value,
                          ),
                        );
                      }}
                    >
                      <option value="judge">judge</option>
                      <option value="skip">skip</option>
                    </select>
                    <p>
                      {t(
                        "pilotDeckConfig.panels.router.ui.subagentPolicyDescription",
                      )}
                    </p>
                  </div>
                  {subagentPolicy === "skip" ? (
                    <div className="advanced-strategy-model-row">
                      <div className="route-subagent-model-setting compact">
                        <div className="route-subagent-model-copy">
                          <label>
                            {t(
                              "pilotDeckConfig.panels.router.ui.subagentModel",
                            )}
                          </label>
                          <p>
                            {t(
                              "pilotDeckConfig.panels.router.ui.subagentFixedModelDescription",
                            )}
                          </p>
                        </div>
                        {renderModelSelect(
                          config.agent?.subagents?.default ?? fallbackModel,
                          t(
                            "pilotDeckConfig.panels.router.ui.subagentModel",
                          ),
                          (value) =>
                            updateModel(
                              ["agent", "subagents", "default"],
                              value,
                            ),
                          true,
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>

                <section className="route-card advanced-route-card tier-definition-card">
                  <header className="advanced-section-title-row">
                    <div className="advanced-section-title">
                      <span className="route-heading-icon">
                        <ListOrdered size={18} />
                      </span>
                      <div>
                        <h2>
                          {t(
                            "pilotDeckConfig.panels.router.ui.tierDefinitions",
                          )}
                        </h2>
                        <p>
                          {t(
                            "pilotDeckConfig.panels.router.ui.tierDefinitionsDescription",
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="advanced-section-actions">
                      {editingTiers ? (
                        <>
                          <button
                            className="button secondary compact"
                            type="button"
                            onClick={() => {
                              setTierDraft(tiers);
                              setEditingTiers(false);
                              showSettingsSuccess(
                                t(
                                  "pilotDeckConfig.panels.router.ui.tierDefinitionsCancelled",
                                ),
                              );
                            }}
                          >
                            <X size={15} />
                            {t("pilotDeckConfig.panels.router.ui.cancel")}
                          </button>
                          <button
                            className="button primary compact"
                            type="button"
                            onClick={saveTierDefinitions}
                          >
                            <Save size={15} />
                            {t(
                              "pilotDeckConfig.panels.router.ui.saveChanges",
                            )}
                          </button>
                        </>
                      ) : (
                        <button
                          className="button secondary compact advanced-edit-button"
                          type="button"
                          onClick={() => setEditingTiers(true)}
                        >
                          <EditIcon />
                          {t("pilotDeckConfig.panels.router.ui.edit")}
                        </button>
                      )}
                    </div>
                  </header>
                  <div className="tier-definition-list">
                    {Object.entries(tierDraft).map(([key, tier]) => {
                      const preset =
                        DEFAULT_TIERS[key as keyof typeof DEFAULT_TIERS];
                      const removable = !ROUTER_TIER_KEYS.includes(
                        key as (typeof ROUTER_TIER_KEYS)[number],
                      );
                      const localizedTierLabel = preset
                        && (!tier.label || tier.label === preset.label)
                        ? t(
                            `pilotDeckConfig.panels.router.levels.${key}.label`,
                          )
                        : tier.label || key;
                      const localizedTierDescription =
                        preset &&
                        (!tier.description ||
                          tier.description === preset.description)
                          ? t(
                              `pilotDeckConfig.panels.router.levels.${key}.description`,
                            )
                          : tier.description ?? "";
                      return (
                        <div
                          key={key}
                          className={`tier-definition-row${editingTiers ? " is-editing" : ""}`}
                        >
                          <input
                            className="tier-definition-label"
                            aria-label={t(
                              "pilotDeckConfig.panels.router.ui.tierName",
                              { label: localizedTierLabel },
                            )}
                            value={localizedTierLabel}
                            disabled={!editingTiers}
                            onChange={(event) =>
                              setTierDraft((current) => ({
                                ...current,
                                [key]: {
                                  ...current[key],
                                  label: event.target.value,
                                },
                              }))
                            }
                          />
                          <textarea
                            className="tier-definition-description"
                            rows={1}
                            aria-label={t(
                              "pilotDeckConfig.panels.router.ui.tierDescription",
                              { label: localizedTierLabel },
                            )}
                            value={localizedTierDescription}
                            disabled={!editingTiers}
                            onChange={(event) =>
                              setTierDraft((current) => ({
                                ...current,
                                [key]: {
                                  ...current[key],
                                  description: event.target.value,
                                },
                              }))
                            }
                          />
                          {editingTiers && removable ? (
                            <button
                              type="button"
                              aria-label={t(
                                "pilotDeckConfig.panels.router.ui.deleteTier",
                              )}
                              onClick={() =>
                                setTierDraft((current) =>
                                  Object.fromEntries(
                                    Object.entries(current).filter(
                                      ([name]) => name !== key,
                                    ),
                                  ),
                                )
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          ) : (
                            <span className="tier-definition-action-placeholder" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="advanced-section-footer-actions">
                    <button
                      className="advanced-add-button"
                      type="button"
                      disabled={!editingTiers}
                      onClick={() => {
                        const key = `custom-${Date.now().toString(36)}`;
                        setTierDraft((current) => ({
                          ...current,
                          [key]: {
                            model: fallbackModel,
                            label: t(
                              "pilotDeckConfig.panels.router.ui.customTier",
                            ),
                            description: "",
                          },
                        }));
                      }}
                    >
                      <Plus size={15} />
                      {t("pilotDeckConfig.panels.router.ui.add")}
                    </button>
                  </div>
                </section>

                <section className="route-card advanced-route-card model-pricing-card">
                  <header className="advanced-section-title-row">
                    <div className="advanced-section-title">
                      <span className="route-heading-icon">
                        <ModelPricingIcon />
                      </span>
                      <div>
                        <h2>
                          {t("pilotDeckConfig.panels.router.pricing.title")}
                        </h2>
                        <p>
                          {t(
                            "pilotDeckConfig.panels.router.ui.pricingDescription",
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="advanced-section-actions">
                      {editingPricing ? (
                        <>
                          <button
                            className="button secondary compact"
                            type="button"
                            onClick={() => {
                              setPricingDraft(r.stats?.modelPricing ?? {});
                              setEditingPricing(false);
                              showSettingsSuccess(
                                t(
                                  "pilotDeckConfig.panels.router.ui.pricingCancelled",
                                ),
                              );
                            }}
                          >
                            <X size={15} />
                            {t("pilotDeckConfig.panels.router.ui.cancel")}
                          </button>
                          <button
                            className="button primary compact"
                            type="button"
                            onClick={savePricing}
                          >
                            <Save size={15} />
                            {t(
                              "pilotDeckConfig.panels.router.ui.saveChanges",
                            )}
                          </button>
                        </>
                      ) : (
                        <button
                          className="button secondary compact advanced-edit-button"
                          type="button"
                          onClick={() => setEditingPricing(true)}
                        >
                          <EditIcon />
                          {t("pilotDeckConfig.panels.router.ui.edit")}
                        </button>
                      )}
                    </div>
                  </header>
                  <div className="model-pricing-list">
                    {pricingRows.map(({ ref, label }) => {
                      const entry =
                        pricingDraft[ref] ??
                        r.stats?.modelPricing?.[ref] ??
                        getBuiltInPricing(ref) ??
                        {};
                      const updatePrice = (
                        field: "input" | "output" | "cacheRead",
                        raw: string,
                      ) => {
                        setPricingDraft((current) => ({
                          ...current,
                          [ref]: {
                            ...(current[ref] ?? entry),
                            [field]: raw === "" ? undefined : Number(raw),
                          },
                        }));
                      };
                      return (
                        <div className="model-pricing-row" key={ref}>
                          <strong title={label}>{label}</strong>
                          {(["input", "output", "cacheRead"] as const).map(
                            (field) => (
                              <label key={field}>
                                <span>
                                  {field === "input"
                                    ? t(
                                        "pilotDeckConfig.panels.router.ui.pricingInput",
                                      )
                                    : field === "output"
                                      ? t(
                                          "pilotDeckConfig.panels.router.ui.pricingOutput",
                                        )
                                      : t(
                                          "pilotDeckConfig.panels.router.ui.pricingCache",
                                        )}
                                </span>
                                <input
                                  min="0"
                                  step="0.01"
                                  type="number"
                                  disabled={!editingPricing}
                                  value={entry[field] ?? ""}
                                  onChange={(event) =>
                                    updatePrice(field, event.target.value)
                                  }
                                />
                              </label>
                            ),
                          )}
                          <select
                            aria-label={t(
                              "pilotDeckConfig.panels.router.ui.pricingUnit",
                              { label },
                            )}
                            disabled={!editingPricing}
                            value={entry.unit ?? "$/百万 Token"}
                            onChange={(event) =>
                              setPricingDraft((current) => ({
                                ...current,
                                [ref]: {
                                  ...(current[ref] ?? entry),
                                  unit: event.target.value as
                                    | "$/百万 Token"
                                    | "¥/百万 Token",
                                },
                              }))
                            }
                          >
                            <option value="$/百万 Token">
                              {t(
                                "pilotDeckConfig.panels.router.ui.millionTokenUnitUsd",
                              )}
                            </option>
                            <option value="¥/百万 Token">
                              {t(
                                "pilotDeckConfig.panels.router.ui.millionTokenUnitCny",
                              )}
                            </option>
                          </select>
                          <button
                            type="button"
                            disabled={!editingPricing}
                            aria-label={t(
                              "pilotDeckConfig.panels.router.ui.clearPricing",
                            )}
                            onClick={() =>
                              setPricingDraft((current) => ({
                                ...current,
                                [ref]: {},
                              }))
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            ) : null}
          </section>
        </fieldset>
      )}
    </div>
  );
}
