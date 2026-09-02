import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsProject } from "../../../shared/types";
import { SettingsToggle } from "../../../shared/view";
import {
  getAlwaysOnProjectRoot,
  isAlwaysOnProjectEnabled,
  setAlwaysOnProjectEnabled,
} from "../../../shared/utils/alwaysOnConfigPatch";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

type AlwaysOnSectionProps = {
  config: PilotDeckConfig;
  projects: SettingsProject[];
  onChange: (next: PilotDeckConfig) => void;
};

const CHANNEL_OPTIONS = ["desktop", "current", "silent"] as const;

type TriggerDraft = {
  tickIntervalMinutes: string;
  cooldownMinutes: string;
  dailyBudget: string;
  heartbeatStaleSeconds: string;
  recentUserMsgMinutes: string;
  preferChannel: string;
};

type NumericTriggerKey = Exclude<keyof TriggerDraft, "preferChannel">;

const DEFAULT_TRIGGER_VALUES: Record<NumericTriggerKey, number> = {
  tickIntervalMinutes: 5,
  cooldownMinutes: 60,
  dailyBudget: 4,
  heartbeatStaleSeconds: 90,
  recentUserMsgMinutes: 5,
};

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" />
    </svg>
  );
}

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
    >
      <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z" />
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
    >
      <path d="M222.14,69.17,186.83,33.86A19.86,19.86,0,0,0,172.69,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V83.31A19.86,19.86,0,0,0,222.14,69.17ZM164,204H92V160h72Zm40,0H188V156a20,20,0,0,0-20-20H88a20,20,0,0,0-20,20v48H52V52H171l33,33ZM164,84a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h56A12,12,0,0,1,164,84Z" />
    </svg>
  );
}

function projectLabel(project: SettingsProject): string {
  return (project.displayName || project.name || "").trim();
}

function numberToDraft(
  value: number | undefined,
  fallback: number,
  explicitlyCleared: boolean,
): string {
  if (value !== undefined) return String(value);
  return explicitlyCleared ? "" : String(fallback);
}

function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function isValidNumberDraft(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0;
}

function triggerToDraft(
  trigger: NonNullable<PilotDeckConfig["alwaysOn"]>["trigger"],
  clearedFields: ReadonlySet<NumericTriggerKey> = new Set(),
): TriggerDraft {
  const preferredChannel = CHANNEL_OPTIONS.includes(
    trigger?.preferChannel as (typeof CHANNEL_OPTIONS)[number],
  )
    ? trigger?.preferChannel
    : "current";

  return {
    tickIntervalMinutes: numberToDraft(
      trigger?.tickIntervalMinutes,
      DEFAULT_TRIGGER_VALUES.tickIntervalMinutes,
      clearedFields.has("tickIntervalMinutes"),
    ),
    cooldownMinutes: numberToDraft(
      trigger?.cooldownMinutes,
      DEFAULT_TRIGGER_VALUES.cooldownMinutes,
      clearedFields.has("cooldownMinutes"),
    ),
    dailyBudget: numberToDraft(
      trigger?.dailyBudget,
      DEFAULT_TRIGGER_VALUES.dailyBudget,
      clearedFields.has("dailyBudget"),
    ),
    heartbeatStaleSeconds: numberToDraft(
      trigger?.heartbeatStaleSeconds,
      DEFAULT_TRIGGER_VALUES.heartbeatStaleSeconds,
      clearedFields.has("heartbeatStaleSeconds"),
    ),
    recentUserMsgMinutes: numberToDraft(
      trigger?.recentUserMsgMinutes,
      DEFAULT_TRIGGER_VALUES.recentUserMsgMinutes,
      clearedFields.has("recentUserMsgMinutes"),
    ),
    preferChannel: preferredChannel,
  };
}

export default function AlwaysOnSection({
  config,
  projects,
  onChange,
}: AlwaysOnSectionProps) {
  const { t } = useTranslation("settings");
  const trigger = config.alwaysOn?.trigger ?? {};
  const [projectQuery, setProjectQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [clearedNumericFields, setClearedNumericFields] = useState<
    Set<NumericTriggerKey>
  >(() => new Set());
  const [draft, setDraft] = useState<TriggerDraft>(() => triggerToDraft(trigger));

  useEffect(() => {
    if (editing) return;
    setDraft(triggerToDraft(trigger, clearedNumericFields));
  }, [
    clearedNumericFields,
    editing,
    trigger.tickIntervalMinutes,
    trigger.cooldownMinutes,
    trigger.dailyBudget,
    trigger.heartbeatStaleSeconds,
    trigger.recentUserMsgMinutes,
    trigger.preferChannel,
  ]);

  const projectRows = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          root: getAlwaysOnProjectRoot(project),
          label: projectLabel(project),
        }))
        .filter((item) => item.root.length > 0),
    [projects],
  );

  const filteredProjectRows = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projectRows;
    return projectRows.filter((item) =>
      item.label.toLowerCase().includes(query),
    );
  }, [projectQuery, projectRows]);

  const canSave =
    isValidNumberDraft(draft.tickIntervalMinutes) &&
    isValidNumberDraft(draft.cooldownMinutes) &&
    isValidNumberDraft(draft.dailyBudget) &&
    isValidNumberDraft(draft.heartbeatStaleSeconds) &&
    isValidNumberDraft(draft.recentUserMsgMinutes);

  const startEdit = () => {
    setDraft(triggerToDraft(trigger, clearedNumericFields));
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(triggerToDraft(trigger, clearedNumericFields));
    setEditing(false);
  };

  const commitEdit = () => {
    if (!canSave) return;
    setClearedNumericFields(
      new Set(
        (Object.keys(DEFAULT_TRIGGER_VALUES) as NumericTriggerKey[]).filter(
          (key) => draft[key].trim() === "",
        ),
      ),
    );
    const nextTrigger = {
      ...trigger,
      tickIntervalMinutes: parseOptionalNumber(draft.tickIntervalMinutes),
      cooldownMinutes: parseOptionalNumber(draft.cooldownMinutes),
      dailyBudget: parseOptionalNumber(draft.dailyBudget),
      heartbeatStaleSeconds: parseOptionalNumber(draft.heartbeatStaleSeconds),
      recentUserMsgMinutes: parseOptionalNumber(draft.recentUserMsgMinutes),
      preferChannel: draft.preferChannel,
    };
    onChange(patch(config, ["alwaysOn", "trigger"], nextTrigger));
    setEditing(false);
  };

  const updateDraft = (key: keyof TriggerDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const numberField = (
    id: string,
    labelKey: string,
    descriptionKey: string,
    draftKey: NumericTriggerKey,
  ) => (
    <div className="resident-setting-row">
      <div className="resident-setting-copy">
        <label htmlFor={id}>{t(labelKey)}</label>
        <p>{t(descriptionKey)}</p>
      </div>
      <div className="resident-editable-control">
        <div className="resident-input-wrap">
          <input
            id={id}
            disabled={!editing}
            min={0}
            inputMode="numeric"
            type="number"
            value={draft[draftKey]}
            onChange={(event) => updateDraft(draftKey, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              }
              if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !event.shiftKey
              ) {
                event.preventDefault();
                commitEdit();
              }
            }}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="resident-settings-layout">
      <aside
        className="resident-project-panel"
        aria-labelledby="resident-projects-title"
      >
        <header className="resident-project-panel-header">
          <div className="resident-project-panel-heading">
            <h2 id="resident-projects-title">
              {t("pilotDeckConfig.panels.alwaysOn.workspaceOptIn.title")}
            </h2>
            <p>
              {t("pilotDeckConfig.panels.alwaysOn.workspaceOptIn.description")}
            </p>
          </div>
        </header>
        <div className="resident-project-search">
          <SearchIcon />
          <input
            type="search"
            value={projectQuery}
            placeholder={t(
              "pilotDeckConfig.panels.alwaysOn.workspaceOptIn.searchPlaceholder",
            )}
            aria-label={t(
              "pilotDeckConfig.panels.alwaysOn.workspaceOptIn.searchAria",
            )}
            onChange={(event) => setProjectQuery(event.target.value)}
          />
        </div>
        <div className="resident-project-list" role="list">
          {projectRows.length === 0 || filteredProjectRows.length === 0 ? (
            <p className="resident-project-empty">
              {t(
                projectRows.length === 0
                  ? "pilotDeckConfig.panels.alwaysOn.workspaceOptIn.empty"
                  : "pilotDeckConfig.panels.alwaysOn.workspaceOptIn.searchEmpty",
              )}
            </p>
          ) : (
            filteredProjectRows.map(({ project, root, label }) => {
              const name = label || root;
              return (
                <div className="resident-project-row" role="listitem" key={root}>
                  <span title={name}>{name}</span>
                  <SettingsToggle
                    checked={isAlwaysOnProjectEnabled(config, project)}
                    ariaLabel={t(
                      "pilotDeckConfig.panels.alwaysOn.workspaceOptIn.toggleAria",
                      { name },
                    )}
                    onChange={(isEnabled) =>
                      onChange(
                        setAlwaysOnProjectEnabled(config, project, isEnabled),
                      )
                    }
                    successLabel={`${name}常驻`}
                    suppressNextSaveToast
                  />
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="resident-config-stack">
        <section
          className="resident-section"
          aria-labelledby="resident-trigger-title"
        >
          <div className="resident-card expanded">
            <header className="resident-section-header">
              <div className="resident-section-title-line">
                <h2 id="resident-trigger-title">
                  {t("pilotDeckConfig.panels.alwaysOn.trigger.title")}
                </h2>
                <p>{t("pilotDeckConfig.panels.alwaysOn.trigger.description")}</p>
              </div>
              <div className="resident-section-header-controls">
                <div className="resident-section-actions">
                  {editing ? (
                    <>
                      <button
                        className="button secondary compact resident-section-action"
                        type="button"
                        onClick={cancelEdit}
                      >
                        {t("settingsPage.actions.cancel")}
                      </button>
                      <button
                        className="button primary compact resident-section-action"
                        type="button"
                        disabled={!canSave}
                        onClick={commitEdit}
                      >
                        <SaveIcon />
                        {t("settingsPage.actions.save")}
                      </button>
                    </>
                  ) : (
                    <button
                      className="button secondary compact edit-provider-button resident-section-action"
                      type="button"
                      onClick={startEdit}
                    >
                      <EditIcon />
                      {t("settingsPage.actions.edit")}
                    </button>
                  )}
                </div>
              </div>
            </header>
            <div
              className="resident-section-content"
              id="resident-trigger-content"
            >
              <div className="resident-parameter-grid">
                <div className="resident-parameter-row">
                  {numberField(
                    "resident-checkInterval",
                    "pilotDeckConfig.panels.alwaysOn.trigger.tickInterval.label",
                    "pilotDeckConfig.panels.alwaysOn.trigger.tickInterval.description",
                    "tickIntervalMinutes",
                  )}
                  {numberField(
                    "resident-cooldown",
                    "pilotDeckConfig.panels.alwaysOn.trigger.cooldown.label",
                    "pilotDeckConfig.panels.alwaysOn.trigger.cooldown.description",
                    "cooldownMinutes",
                  )}
                </div>
                <div className="resident-parameter-row">
                  {numberField(
                    "resident-dailyBudget",
                    "pilotDeckConfig.panels.alwaysOn.trigger.dailyBudget.label",
                    "pilotDeckConfig.panels.alwaysOn.trigger.dailyBudget.description",
                    "dailyBudget",
                  )}
                  {numberField(
                    "resident-heartbeatExpiry",
                    "pilotDeckConfig.panels.alwaysOn.trigger.heartbeatStale.label",
                    "pilotDeckConfig.panels.alwaysOn.trigger.heartbeatStale.description",
                    "heartbeatStaleSeconds",
                  )}
                </div>
                <div className="resident-parameter-row">
                  {numberField(
                    "resident-recentMessageWindow",
                    "pilotDeckConfig.panels.alwaysOn.trigger.recentUserMsg.label",
                    "pilotDeckConfig.panels.alwaysOn.trigger.recentUserMsg.description",
                    "recentUserMsgMinutes",
                  )}
                  <div className="resident-setting-row">
                    <div className="resident-setting-copy">
                      <label htmlFor="resident-preferred-channel">
                        {t(
                          "pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.label",
                        )}
                      </label>
                      <p>
                        {t(
                          "pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.description",
                        )}
                      </p>
                    </div>
                    <div className="resident-select-wrap">
                      <select
                        id="resident-preferred-channel"
                        disabled={!editing}
                        value={draft.preferChannel}
                        onChange={(event) =>
                          updateDraft("preferChannel", event.target.value)
                        }
                      >
                        {CHANNEL_OPTIONS.map((value) => (
                          <option key={value} value={value}>
                            {t(
                              `pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.options.${value}`,
                            )}
                          </option>
                        ))}
                      </select>
                      <ChevronIcon />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
