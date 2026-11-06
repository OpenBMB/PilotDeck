import { isOptionalFeatureEnabled } from "../../../../../../src/pilot/config/optionalFeature.js";
import { useMemo, useState } from "react";
import { Brain, Pencil } from "lucide-react";
import { GeneralSelectControl, GeneralSettingRow, GeneralSettingsIcon } from "../../shared/view/GeneralSettingsPrimitives";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { findCatalogProviderById } from "../../../../shared/catalogProviders";
import { ConfigSaveError, SettingsToggle } from "../../shared/view";
import { queueSettingsSaveSuccess } from "../../shared/SettingsSuccessToast";
import { patch } from "../modelPool/utils/patch";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import {
  buildModelRefOptions,
  ensureModelRefConfigured,
} from "../modelPool/utils/modelRefs";
import type { SettingsProject } from "../../shared/types";
import MemoryDataSection from "./MemoryDataSection";
import {
  DEFAULT_DREAM_MINUTES,
  DEFAULT_INDEX_MINUTES,
  DREAM_INTERVAL_UNITS,
  INDEX_INTERVAL_UNITS,
  parseIntervalUnit,
  resolveEnabledMemoryIntervals,
  toDisplayUnit,
  toDisplayValue,
  toMinutes,
  type IntervalUnit,
} from "./memoryIntervals";

type AgentMemorySectionsProps = {
  title: string;
  projects: SettingsProject[];
};

function ChevronIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z" />
    </svg>
  );
}

function MemorySection({
  config,
  onChange,
}: {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
}) {
  const { t } = useTranslation("settings");
  const m = config.memory ?? {};
  const enabled = isOptionalFeatureEnabled(config.memory);
  const selected = m.model && m.model.trim() ? m.model : "inherit";
  const modelOptions = buildModelRefOptions(config);

  const groupedModels = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; options: Array<{ value: string; label: string }> }
    >();
    for (const option of modelOptions) {
      const slash = option.value.indexOf("/");
      const provider = slash > 0 ? option.value.slice(0, slash) : "其他";
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
        label: `${providerLabel} · ${modelLabel}`,
      });
      groups.set(provider, group);
    }
    return [...groups.entries()];
  }, [modelOptions]);

  const selectedModelLabel =
    selected === "inherit"
      ? t("pilotDeckConfig.panels.memory.model.inherit")
      : groupedModels
          .flatMap(([, group]) => group.options)
          .find((option) => option.value === selected)?.label ?? selected;

  const initialIndex = toDisplayUnit(
    m.autoIndexIntervalMinutes,
    DEFAULT_INDEX_MINUTES,
    INDEX_INTERVAL_UNITS,
  );
  const initialDream = toDisplayUnit(
    m.autoDreamIntervalMinutes,
    DEFAULT_DREAM_MINUTES,
    DREAM_INTERVAL_UNITS,
  );
  const [indexUnit, setIndexUnit] = useState<IntervalUnit>(initialIndex.unit);
  const [dreamUnit, setDreamUnit] = useState<IntervalUnit>(initialDream.unit);
  const [indexEditing, setIndexEditing] = useState(false);
  const [indexDraftValue, setIndexDraftValue] = useState(String(initialIndex.value));
  const [indexDraftUnit, setIndexDraftUnit] = useState<IntervalUnit>(initialIndex.unit);
  const [dreamEditing, setDreamEditing] = useState(false);
  const [dreamDraftValue, setDreamDraftValue] = useState(String(initialDream.value));
  const [dreamDraftUnit, setDreamDraftUnit] = useState<IntervalUnit>(initialDream.unit);

  const applyIndex = (value: number | undefined, unit: IntervalUnit) => {
    onChange(
      patch(config, ["memory", "autoIndexIntervalMinutes"], toMinutes(value, unit)),
    );
  };

  const applyDream = (value: number | undefined, unit: IntervalUnit) => {
    onChange(
      patch(config, ["memory", "autoDreamIntervalMinutes"], toMinutes(value, unit)),
    );
  };

  const handleMemoryEnabled = (nextEnabled: boolean) => {
    let next = patch(config, ["memory", "enabled"], nextEnabled);
    if (nextEnabled) {
      const intervals = resolveEnabledMemoryIntervals(config.memory);
      next = patch(
        next,
        ["memory", "autoIndexIntervalMinutes"],
        intervals.autoIndexIntervalMinutes,
      );
      next = patch(
        next,
        ["memory", "autoDreamIntervalMinutes"],
        intervals.autoDreamIntervalMinutes,
      );
    } else {
      setIndexEditing(false);
      setDreamEditing(false);
    }
    onChange(next);
  };

  const indexValueDisplay = toDisplayValue(
    m.autoIndexIntervalMinutes,
    indexUnit,
    DEFAULT_INDEX_MINUTES,
  );

  const dreamValueDisplay = toDisplayValue(
    m.autoDreamIntervalMinutes,
    dreamUnit,
    DEFAULT_DREAM_MINUTES,
  );

  const commitIndex = () => {
    const parsed = Number(indexDraftValue);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setIndexUnit(indexDraftUnit);
    applyIndex(parsed, indexDraftUnit);
    setIndexEditing(false);
  };

  const cancelIndex = () => {
    setIndexDraftValue(String(indexValueDisplay));
    setIndexDraftUnit(indexUnit);
    setIndexEditing(false);
  };

  const commitDream = () => {
    const parsed = Number(dreamDraftValue);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setDreamUnit(dreamDraftUnit);
    applyDream(parsed, dreamDraftUnit);
    setDreamEditing(false);
  };

  const cancelDream = () => {
    setDreamDraftValue(String(dreamValueDisplay));
    setDreamDraftUnit(dreamUnit);
    setDreamEditing(false);
  };

  const startIndexEdit = () => {
    cancelDream();
    setIndexDraftValue(String(indexValueDisplay));
    setIndexDraftUnit(indexUnit);
    setIndexEditing(true);
  };

  const startDreamEdit = () => {
    cancelIndex();
    setDreamDraftValue(String(dreamValueDisplay));
    setDreamDraftUnit(dreamUnit);
    setDreamEditing(true);
  };

  const renderIntervalRow = ({
    id,
    unitId,
    label,
    description,
    editing,
    draftValue,
    draftUnit,
    displayValue,
    unit,
    onDraftValue,
    onDraftUnit,
    onEdit,
    onCancel,
    onCommit,
    editLocked = false,
    units,
  }: {
    id: string;
    unitId: string;
    label: string;
    description: string;
    editing: boolean;
    draftValue: string;
    draftUnit: IntervalUnit;
    displayValue: number;
    unit: IntervalUnit;
    onDraftValue: (value: string) => void;
    onDraftUnit: (unit: IntervalUnit) => void;
    onEdit: () => void;
    onCancel: () => void;
    onCommit: () => void;
    editLocked?: boolean;
    units: readonly IntervalUnit[];
  }) => {
    const controlsDisabled = !enabled || !editing;
    const canSave = Number.isFinite(Number(draftValue)) && Number(draftValue) >= 0;
    return (
      <GeneralSettingRow htmlFor={id} title={label} detail={description}>
        <div className="memory-interval-control">
          <input
            id={id}
            className="general-input"
            min={0}
            type="number"
            disabled={controlsDisabled}
            value={editing ? draftValue : String(displayValue)}
            onChange={(event) => onDraftValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
              if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !event.shiftKey
              ) {
                event.preventDefault();
                onCommit();
              }
            }}
          />
          <GeneralSelectControl
            compact id={unitId} disabled={controlsDisabled} ariaLabel={label}
            value={editing ? draftUnit : unit}
            onChange={value => { if (editing) onDraftUnit(parseIntervalUnit(value, units)); }}
            options={units.map(value => ({ value, label: t(`pilotDeckConfig.panels.memory.intervalUnits.${value}`) }))}
          />
          <div className="memory-interval-actions">
            {editing ? (
              <>
                <button
                  className="button secondary compact"
                  type="button"
                  onClick={onCancel}
                >
                  {t("settingsPage.actions.cancel")}
                </button>
                <button
                  className="button primary compact"
                  type="button"
                  disabled={!canSave}
                  onClick={onCommit}
                >
                  {t("settingsPage.actions.save")}
                </button>
              </>
            ) : (
              <button
                className="button secondary compact"
                type="button"
                disabled={!enabled || editLocked}
                onClick={onEdit}
              >
                <GeneralSettingsIcon icon={Pencil} /> {t("settingsPage.actions.edit")}
              </button>
            )}
          </div>
        </div>
      </GeneralSettingRow>
    );
  };

  return (
    <>
      <section className="general-card">
        <GeneralSettingRow icon={<GeneralSettingsIcon icon={Brain} />}
          title={t("pilotDeckConfig.panels.memory.enabled.label")}
          detail={t("pilotDeckConfig.panels.memory.enabled.description")}>
          <SettingsToggle checked={enabled} ariaLabel={t("pilotDeckConfig.panels.memory.enabled.label")}
            onChange={handleMemoryEnabled} suppressNextSaveToast />
        </GeneralSettingRow>
      </section>

      <section
        className="general-card memory-config-card"
        aria-label={t("pilotDeckConfig.panels.memory.title")}
      >
        <div className={`memory-config-body${enabled ? "" : " disabled"}`}>
          <GeneralSettingRow htmlFor="memory-model"
            title={t("pilotDeckConfig.panels.memory.model.label")}
            detail={t("pilotDeckConfig.panels.memory.model.description")}>
            <div className="general-select-wrap">
              <select
                id="memory-model"
                data-model-reference="memory.model"
                disabled={!enabled}
                value={selected}
                onChange={(event) => {
                  const nextValue =
                    event.target.value === "inherit" ? "" : event.target.value;
                  const nextLabel =
                    event.target.selectedOptions[0]?.text || event.target.value;
                  queueSettingsSaveSuccess(
                    `${t("pilotDeckConfig.panels.memory.model.label")}已切换为 ${nextLabel}`,
                  );
                  onChange(
                    patch(
                      ensureModelRefConfigured(config, nextValue),
                      ["memory", "model"],
                      nextValue,
                    ),
                  );
                }}
              >
                <option value="inherit">
                  {t("pilotDeckConfig.panels.memory.model.inherit")}
                </option>
                {selected !== "inherit" &&
                !groupedModels.some(([, group]) =>
                  group.options.some((option) => option.value === selected),
                ) ? (
                  <option value={selected}>{selectedModelLabel}</option>
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
              <ChevronIcon />
            </div>
          </GeneralSettingRow>

          {renderIntervalRow({
            id: "memory-indexing-value",
            unitId: "memory-indexing-unit",
            label: t("pilotDeckConfig.panels.memory.autoIndexInterval.label"),
            description: t(
              "pilotDeckConfig.panels.memory.autoIndexInterval.description",
            ),
            editing: indexEditing,
            draftValue: indexDraftValue,
            draftUnit: indexDraftUnit,
            displayValue: indexValueDisplay,
            unit: indexUnit,
            onDraftValue: setIndexDraftValue,
            onDraftUnit: setIndexDraftUnit,
            onEdit: startIndexEdit,
            onCancel: cancelIndex,
            onCommit: commitIndex,
            editLocked: dreamEditing,
            units: INDEX_INTERVAL_UNITS,
          })}

          {renderIntervalRow({
            id: "memory-dream-value",
            unitId: "memory-dream-unit",
            label: t("pilotDeckConfig.panels.memory.autoDreamInterval.label"),
            description: t(
              "pilotDeckConfig.panels.memory.autoDreamInterval.description",
            ),
            editing: dreamEditing,
            draftValue: dreamDraftValue,
            draftUnit: dreamDraftUnit,
            displayValue: dreamValueDisplay,
            unit: dreamUnit,
            onDraftValue: setDreamDraftValue,
            onDraftUnit: setDreamDraftUnit,
            onEdit: startDreamEdit,
            onCancel: cancelDream,
            onCommit: commitDream,
            editLocked: indexEditing,
            units: DREAM_INTERVAL_UNITS,
          })}
        </div>
      </section>
    </>
  );
}

export default function AgentMemorySections({
  title: _title,
  projects,
}: AgentMemorySectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      void commitRaw(configToYamlString(next));
    } catch (caught) {
      console.error("Failed to serialise agent memory config patch", caught);
    }
  };

  if (loading) {
    return (
      <div className="memory-page-content">
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="memory-page-content">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-[var(--pd-danger-ink)]">
          {t("settingsPage.invalidYaml.agentMemory")}
        </div>
      </div>
    );
  }

  return (
    <div className="memory-page-content">
      <ConfigSaveError error={error} />
      <MemorySection config={parsedConfig} onChange={onFormChange} />
      <MemoryDataSection projects={projects} />
    </div>
  );
}
