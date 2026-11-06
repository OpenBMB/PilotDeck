import { useEffect, useState } from "react";
import { Clock3, Pencil, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import SettingsToggle from "../../../shared/view/SettingsToggle";
import { GeneralSettingRow, GeneralSelectControl, GeneralSettingsIcon } from "../../../shared/view/GeneralSettingsPrimitives";
import { isCronConfigEnabled } from "../utils/cron";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

type CronSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

type EditingField = "timezone" | "maxConcurrentRuns";

const TIMEZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Europe/London",
  "America/Los_Angeles",
];

export default function CronSection({ config, onChange }: CronSectionProps) {
  const { t } = useTranslation("settings");
  const cron = config.cron ?? {};
  const timezone = cron.timezone ?? "UTC";
  const maxConcurrentRuns = cron.maxConcurrentRuns ?? 1;
  const [editingField, setEditingField] = useState<EditingField | null>(null);
  const [timezoneDraft, setTimezoneDraft] = useState(timezone);
  const [concurrencyDraft, setConcurrencyDraft] = useState(
    String(maxConcurrentRuns),
  );

  useEffect(() => {
    if (editingField !== "timezone") setTimezoneDraft(timezone);
    if (editingField !== "maxConcurrentRuns") {
      setConcurrencyDraft(String(maxConcurrentRuns));
    }
  }, [editingField, maxConcurrentRuns, timezone]);

  const timezoneOptions = TIMEZONES.includes(timezone)
    ? TIMEZONES
    : [timezone, ...TIMEZONES];

  const startEdit = (field: EditingField) => {
    if (field === "timezone") setTimezoneDraft(timezone);
    else setConcurrencyDraft(String(maxConcurrentRuns));
    setEditingField(field);
  };

  const cancelEdit = () => {
    setTimezoneDraft(timezone);
    setConcurrencyDraft(String(maxConcurrentRuns));
    setEditingField(null);
  };

  const saveTimezone = () => {
    onChange(patch(config, ["cron", "timezone"], timezoneDraft));
    setEditingField(null);
  };

  const parsedConcurrency = Number(concurrencyDraft);
  const concurrencyIsValid =
    Number.isInteger(parsedConcurrency) &&
    parsedConcurrency >= 1 &&
    parsedConcurrency <= 20;

  const saveConcurrency = () => {
    if (!concurrencyIsValid) return;
    onChange(
      patch(config, ["cron", "maxConcurrentRuns"], parsedConcurrency),
    );
    setEditingField(null);
  };

  const renderActions = (
    field: EditingField,
    canSave: boolean,
    onSave: () => void,
  ) =>
    editingField === field ? (
      <div className="scheduled-inline-actions">
        <button
          className="button secondary compact"
          type="button"
          onClick={cancelEdit}
        >
          <GeneralSettingsIcon icon={X} />
          {t("settingsPage.actions.cancel")}
        </button>
        <button
          className="button primary compact"
          type="button"
          disabled={!canSave}
          onClick={onSave}
        >
          <GeneralSettingsIcon icon={Save} />
          {t("settingsPage.actions.save")}
        </button>
      </div>
    ) : (
      <button
        className="button secondary compact"
        type="button"
        disabled={editingField !== null}
        onClick={() => startEdit(field)}
      >
        <GeneralSettingsIcon icon={Pencil} />
        {t("settingsPage.actions.edit")}
      </button>
    );

  return (
    <>
    <section className="general-card">
      <GeneralSettingRow icon={<GeneralSettingsIcon icon={Clock3} />} title={t("pilotDeckConfig.panels.cron.enableLabel")}>
        <SettingsToggle checked={isCronConfigEnabled(config)} ariaLabel={t("pilotDeckConfig.panels.cron.enableLabel")}
          suppressNextSaveToast onChange={enabled => { onChange(patch(config, ["cron", "enabled"], enabled)); setEditingField(null); }} />
      </GeneralSettingRow>
    </section>
    <section className="general-card" aria-label={t("pilotDeckConfig.panels.cron.configAria")}>
      <GeneralSettingRow htmlFor="scheduled-timezone" title={t("pilotDeckConfig.panels.cron.timezone.label")}
        detail={t("pilotDeckConfig.panels.cron.timezone.description")}>
        <div className="scheduled-control-area">
          <GeneralSelectControl id="scheduled-timezone"
            value={editingField === "timezone" ? timezoneDraft : timezone}
            disabled={editingField !== "timezone"} onChange={setTimezoneDraft}
            options={timezoneOptions.map(value => ({ value, label: value }))} />
          {renderActions("timezone", timezoneDraft !== timezone, saveTimezone)}
        </div>
      </GeneralSettingRow>
      <GeneralSettingRow htmlFor="scheduled-concurrency" title={t("pilotDeckConfig.panels.cron.maxConcurrentRuns.label")}
        detail={t("pilotDeckConfig.panels.cron.maxConcurrentRuns.description")}>
        <div className="scheduled-control-area">
          <input id="scheduled-concurrency" className="general-input" type="number" min={1} max={20} inputMode="numeric"
            value={editingField === "maxConcurrentRuns" ? concurrencyDraft : maxConcurrentRuns}
            disabled={editingField !== "maxConcurrentRuns"}
            aria-invalid={editingField === "maxConcurrentRuns" && !concurrencyIsValid}
            onChange={event => setConcurrencyDraft(event.target.value)} />
          {renderActions("maxConcurrentRuns", concurrencyIsValid && parsedConcurrency !== maxConcurrentRuns, saveConcurrency)}
        </div>
      </GeneralSettingRow>
    </section>
    </>
  );
}
