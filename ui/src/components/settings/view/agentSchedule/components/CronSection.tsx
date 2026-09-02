import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

type CronSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

type EditingField = "timezone" | "maxConcurrentRuns";

const TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Europe/London",
  "America/Los_Angeles",
];

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

function EditIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M222.14,69.17,186.83,33.86A19.86,19.86,0,0,0,172.69,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V83.31A19.86,19.86,0,0,0,222.14,69.17ZM164,204H92V160h72Zm40,0H188V156a20,20,0,0,0-20-20H88a20,20,0,0,0-20,20v48H52V52H171l33,33ZM164,84a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h56A12,12,0,0,1,164,84Z" />
    </svg>
  );
}

export default function CronSection({ config, onChange }: CronSectionProps) {
  const { t } = useTranslation("settings");
  const cron = config.cron ?? {};
  const timezone = cron.timezone ?? "Asia/Shanghai";
  const maxConcurrentRuns = cron.maxConcurrentRuns ?? 2;
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
          <CancelIcon />
          {t("settingsPage.actions.cancel")}
        </button>
        <button
          className="button primary compact"
          type="button"
          disabled={!canSave}
          onClick={onSave}
        >
          <SaveIcon />
          {t("settingsPage.actions.save")}
        </button>
      </div>
    ) : (
      <button
        className="button secondary compact scheduled-edit-button"
        type="button"
        disabled={editingField !== null}
        onClick={() => startEdit(field)}
      >
        <EditIcon />
        {t("settingsPage.actions.edit")}
      </button>
    );

  return (
    <section
      className="scheduled-card"
      aria-label={t("pilotDeckConfig.panels.cron.configAria")}
    >
      <div className="scheduled-setting-row">
        <div className="scheduled-setting-copy">
          <label htmlFor="scheduled-timezone">
            {t("pilotDeckConfig.panels.cron.timezone.label")}
          </label>
          <p>{t("pilotDeckConfig.panels.cron.timezone.description")}</p>
        </div>
        <div className="scheduled-control-area">
          <div className="scheduled-select-wrap">
            <select
              id="scheduled-timezone"
              value={editingField === "timezone" ? timezoneDraft : timezone}
              disabled={editingField !== "timezone"}
              onChange={(event) => setTimezoneDraft(event.target.value)}
            >
              {timezoneOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
          {renderActions(
            "timezone",
            timezoneDraft !== timezone,
            saveTimezone,
          )}
        </div>
      </div>

      <div className="scheduled-setting-row">
        <div className="scheduled-setting-copy">
          <label htmlFor="scheduled-concurrency">
            {t("pilotDeckConfig.panels.cron.maxConcurrentRuns.label")}
          </label>
          <p>
            {t("pilotDeckConfig.panels.cron.maxConcurrentRuns.description")}
          </p>
        </div>
        <div className="scheduled-control-area">
          <div className="scheduled-input-wrap">
            <input
              id="scheduled-concurrency"
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              value={
                editingField === "maxConcurrentRuns"
                  ? concurrencyDraft
                  : maxConcurrentRuns
              }
              disabled={editingField !== "maxConcurrentRuns"}
              aria-invalid={
                editingField === "maxConcurrentRuns" && !concurrencyIsValid
              }
              onChange={(event) => setConcurrencyDraft(event.target.value)}
            />
          </div>
          {renderActions(
            "maxConcurrentRuns",
            concurrencyIsValid &&
              parsedConcurrency !== maxConcurrentRuns,
            saveConcurrency,
          )}
        </div>
      </div>
    </section>
  );
}
