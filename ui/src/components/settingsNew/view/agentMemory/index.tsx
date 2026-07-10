import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import {
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "../../shared/view";
import { FormRow, NumberInput, Select } from "../modelPool/components/Inputs";
import { patch } from "../modelPool/utils/patch";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import {
  buildModelRefOptions,
  ensureModelRefConfigured,
} from "../agentModel/utils/modelRefs";

type AgentMemorySectionsProps = {
  title: string;
};

type IntervalUnit = "minutes" | "hours";

const DEFAULT_INDEX_MINUTES = 30;
const DEFAULT_DREAM_MINUTES = 60;

function toDisplayUnit(
  minutesValue: number | undefined,
  fallbackMinutes: number,
): { value: number; unit: IntervalUnit } {
  const resolved = minutesValue && minutesValue > 0 ? minutesValue : fallbackMinutes;
  if (resolved % 60 === 0) {
    return { value: Math.max(1, resolved / 60), unit: "hours" };
  }
  return { value: Math.max(1, resolved), unit: "minutes" };
}

function toMinutes(value: number | undefined, unit: IntervalUnit): number {
  const safe = value && value > 0 ? Math.floor(value) : 1;
  return unit === "hours" ? safe * 60 : safe;
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
  const options = [
    { value: "inherit", label: t("pilotDeckConfig.panels.memory.model.inherit") },
    ...buildModelRefOptions(config),
  ];
  const selected = m.model && m.model.trim() ? m.model : "inherit";

  const initialIndex = toDisplayUnit(
    m.autoIndexIntervalMinutes,
    DEFAULT_INDEX_MINUTES,
  );
  const initialDream = toDisplayUnit(
    m.autoDreamIntervalMinutes,
    DEFAULT_DREAM_MINUTES,
  );
  const [indexUnit, setIndexUnit] = useState<IntervalUnit>(initialIndex.unit);
  const [dreamUnit, setDreamUnit] = useState<IntervalUnit>(initialDream.unit);

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

  const handleMemoryEnabled = (enabled: boolean) => {
    let next = patch(config, ["memory", "enabled"], enabled);
    if (enabled) {
      if (!config.memory?.autoIndexIntervalMinutes) {
        next = patch(next, ["memory", "autoIndexIntervalMinutes"], DEFAULT_INDEX_MINUTES);
      }
      if (!config.memory?.autoDreamIntervalMinutes) {
        next = patch(next, ["memory", "autoDreamIntervalMinutes"], DEFAULT_DREAM_MINUTES);
      }
    }
    onChange(next);
  };

  const indexValueDisplay =
    indexUnit === "hours"
      ? Math.max(1, Math.floor((m.autoIndexIntervalMinutes ?? DEFAULT_INDEX_MINUTES) / 60))
      : m.autoIndexIntervalMinutes ?? DEFAULT_INDEX_MINUTES;

  const dreamValueDisplay =
    dreamUnit === "hours"
      ? Math.max(1, Math.floor((m.autoDreamIntervalMinutes ?? DEFAULT_DREAM_MINUTES) / 60))
      : m.autoDreamIntervalMinutes ?? DEFAULT_DREAM_MINUTES;

  return (
    <div className="space-y-3 pb-6">
      <PageSectionHeader description={t("pilotDeckConfig.panels.memory.description")} />
      <SettingsCard>
        <SettingsRow
          label={t("pilotDeckConfig.panels.memory.enabled.label")}
          description={t("pilotDeckConfig.panels.memory.enabled.description")}
        >
          <SettingsToggle
            checked={Boolean(m.enabled)}
            ariaLabel={t("pilotDeckConfig.panels.memory.enabled.label")}
            onChange={handleMemoryEnabled}
          />
        </SettingsRow>
        {m.enabled && (
          <>
            <FormRow
              label={t("pilotDeckConfig.panels.memory.model.label")}
              description={t("pilotDeckConfig.panels.memory.model.description")}
            >
              <Select
                value={selected}
                options={options}
                onChange={(v) => {
                  const nextValue = v === "inherit" ? "" : v;
                  onChange(
                    patch(
                      ensureModelRefConfigured(config, nextValue),
                      ["memory", "model"],
                      nextValue,
                    ),
                  );
                }}
              />
            </FormRow>

            <div className="grid grid-cols-1 items-start gap-2 px-4 py-2.5 sm:grid-cols-[minmax(360px,1fr)_244px] sm:gap-4">
              <div className="min-w-0">
                <div className="text-[13px] font-medium leading-5 text-foreground">
                  自动索引间隔
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  自动扫描文件的时间周期，“0”表示关闭自动任务。
                </div>
              </div>
              <div className="flex items-center justify-end gap-3">
                <div className="w-28">
                  <NumberInput
                    value={indexValueDisplay}
                    onChange={(v) => applyIndex(v, indexUnit)}
                  />
                </div>
                <div className="w-28">
                  <Select
                    value={indexUnit}
                    options={[
                      { value: "minutes", label: "分钟" },
                      { value: "hours", label: "小时" },
                    ]}
                    onChange={(v) => {
                      const unit = v === "hours" ? "hours" : "minutes";
                      setIndexUnit(unit);
                      applyIndex(indexValueDisplay, unit);
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 items-start gap-2 px-4 py-2.5 sm:grid-cols-[minmax(360px,1fr)_244px] sm:gap-4">
              <div className="min-w-0">
                <div className="text-[13px] font-medium leading-5 text-foreground">
                  自动Dream间隔
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  自动整理记忆的时间周期。只有自上次Dream以来有记忆文件更新时，自动Dream才会真正执行。
                </div>
              </div>
              <div className="flex items-center justify-end gap-3">
                <div className="w-28">
                  <NumberInput
                    value={dreamValueDisplay}
                    onChange={(v) => applyDream(v, dreamUnit)}
                  />
                </div>
                <div className="w-28">
                  <Select
                    value={dreamUnit}
                    options={[
                      { value: "minutes", label: "分钟" },
                      { value: "hours", label: "小时" },
                    ]}
                    onChange={(v) => {
                      const unit = v === "hours" ? "hours" : "minutes";
                      setDreamUnit(unit);
                      applyDream(dreamValueDisplay, unit);
                    }}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </SettingsCard>
    </div>
  );
}

export default function AgentMemorySections({ title }: AgentMemorySectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading } = usePilotDeckConfig();
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
          配置文件当前不是有效 YAML，暂时无法加载智能体记忆表单。
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <MemorySection config={parsedConfig} onChange={onFormChange} />
    </div>
  );
}
