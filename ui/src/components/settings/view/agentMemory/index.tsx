import { useMemo, useState } from "react";
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
} from "../agentModel/utils/modelRefs";
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

function MemoryEnableIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path
        d="M240,124a48,48,0,0,1-32,45.27h0V176a40,40,0,0,1-80,0,40,40,0,0,1-80,0v-6.73h0a48,48,0,0,1,0-90.54V72a40,40,0,0,1,80,0,40,40,0,0,1,80,0v6.73A48,48,0,0,1,240,124Z"
        opacity="0.2"
      />
      <path d="M248,124a56.11,56.11,0,0,0-32-50.61V72a48,48,0,0,0-88-26.49A48,48,0,0,0,40,72v1.39a56,56,0,0,0,0,101.2V176a48,48,0,0,0,88,26.49A48,48,0,0,0,216,176v-1.41A56.09,56.09,0,0,0,248,124ZM88,208a32,32,0,0,1-31.81-28.56A55.87,55.87,0,0,0,64,180h8a8,8,0,0,0,0-16H64A40,40,0,0,1,50.67,86.27,8,8,0,0,0,56,78.73V72a32,32,0,0,1,64,0v68.26A47.8,47.8,0,0,0,88,128a8,8,0,0,0,0,16,32,32,0,0,1,0,64Zm104-44h-8a8,8,0,0,0,0,16h8a55.87,55.87,0,0,0,7.81-.56A32,32,0,1,1,168,144a8,8,0,0,0,0-16,47.8,47.8,0,0,0-32,12.26V72a32,32,0,0,1,64,0v6.73a8,8,0,0,0,5.33,7.54A40,40,0,0,1,192,164Zm16-52a8,8,0,0,1-8,8h-4a36,36,0,0,1-36-36V80a8,8,0,0,1,16,0v4a20,20,0,0,0,20,20h4A8,8,0,0,1,208,112ZM60,120H56a8,8,0,0,1,0-16h4A20,20,0,0,0,80,84V80a8,8,0,0,1,16,0v4A36,36,0,0,1,60,120Z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z" />
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
  const enabled = Boolean(m.enabled);
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
      <div className="memory-setting-row">
        <div className="memory-setting-copy">
          <label htmlFor={id}>{label}</label>
          <p>{description}</p>
        </div>
        <div className="memory-interval-control">
          <input
            id={id}
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
          <div className="memory-select-wrap compact">
            <select
              id={unitId}
              disabled={controlsDisabled}
              aria-label={label}
              value={editing ? draftUnit : unit}
              onChange={(event) => {
                if (!editing) return;
                onDraftUnit(parseIntervalUnit(event.target.value, units));
              }}
            >
              {units.map((option) => (
                <option key={option} value={option}>
                  {t(`pilotDeckConfig.panels.memory.intervalUnits.${option}`)}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
          <div className="memory-interval-actions">
            {editing ? (
              <>
                <button
                  className="memory-edit-button"
                  type="button"
                  onClick={onCancel}
                >
                  {t("settingsPage.actions.cancel")}
                </button>
                <button
                  className="memory-edit-button editing"
                  type="button"
                  disabled={!canSave}
                  onClick={onCommit}
                >
                  {t("settingsPage.actions.save")}
                </button>
              </>
            ) : (
              <button
                className="memory-edit-button"
                type="button"
                disabled={!enabled || editLocked}
                onClick={onEdit}
              >
                <EditIcon /> {t("settingsPage.actions.edit")}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <section
        className="route-card route-enable-card memory-enable-card"
        aria-label={t("pilotDeckConfig.panels.memory.enabled.label")}
      >
        <div className="route-card-heading">
          <span className="route-heading-icon">
            <MemoryEnableIcon />
          </span>
          <div>
            <h2>{t("pilotDeckConfig.panels.memory.enabled.label")}</h2>
            <p>{t("pilotDeckConfig.panels.memory.enabled.description")}</p>
          </div>
        </div>
        <SettingsToggle
          checked={enabled}
          ariaLabel={t("pilotDeckConfig.panels.memory.enabled.label")}
          onChange={handleMemoryEnabled}
          suppressNextSaveToast
        />
      </section>

      <section
        className="memory-card memory-config-card"
        aria-label={t("pilotDeckConfig.panels.memory.title")}
      >
        <div className={`memory-config-body${enabled ? "" : " disabled"}`}>
          <div className="memory-setting-row">
            <div className="memory-setting-copy">
              <label htmlFor="memory-model">
                {t("pilotDeckConfig.panels.memory.model.label")}
              </label>
              <p>{t("pilotDeckConfig.panels.memory.model.description")}</p>
            </div>
            <div className="memory-select-wrap memory-model-select">
              <select
                id="memory-model"
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
          </div>

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
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
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
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
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
