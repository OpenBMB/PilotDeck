import { KeyRound, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isImeEnterEvent } from "../../../../../utils/ime";
import type { PilotDeckConfig } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";
import { WELL_KNOWN_ENV_KEYS } from "../utils/constants";

type CustomEnvSectionProps = {
  config: PilotDeckConfig;
  onSave: (next: PilotDeckConfig) => Promise<boolean>;
  saving: boolean;
};

export default function CustomEnvSection({
  config,
  onSave,
  saving,
}: CustomEnvSectionProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const editing = draft !== null;
  const envMap = draft ?? config.customEnv ?? {};
  const entries = Object.entries(envMap);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const newValueInputRef = useRef<HTMLInputElement>(null);

  const removeEnv = (key: string) => {
    const next = { ...envMap };
    delete next[key];
    setDraft(next);
  };

  const addEntry = () => {
    const key = newKey.trim();
    if (!key || envMap[key] !== undefined) return;
    setDraft((current) => ({ ...(current ?? {}), [key]: newValue }));
    setNewKey("");
    setNewValue("");
  };

  const addWellKnown = (key: string) => {
    if (envMap[key] !== undefined) return;
    setNewKey(key);
    setNewValue("");
    requestAnimationFrame(() => newValueInputRef.current?.focus());
  };

  const unusedWellKnown = WELL_KNOWN_ENV_KEYS.filter(
    (entry) => envMap[entry.key] === undefined,
  );

  const cancel = () => {
    setDraft(null);
    setNewKey("");
    setNewValue("");
  };

  const commit = async () => {
    if (draft && (await onSave(patch(config, ["customEnv"], draft)))) cancel();
  };

  return (
    <section className="advanced-system-section" aria-labelledby="advanced-environment-title">
      <div className="advanced-settings-card">
        <header className="agent-retry-header advanced-card-header">
          <span className="agent-retry-icon"><KeyRound size={19} /></span>
          <span>
            <strong id="advanced-environment-title">
              {t("pilotDeckConfig.panels.customEnv.title")}
            </strong>
            <small>{t("pilotDeckConfig.panels.customEnv.description")}</small>
          </span>
          <div className="agent-retry-actions">
            {editing ? (
              <>
                <button className="button secondary compact" type="button" onClick={cancel} disabled={saving}>
                  {t("settingsPage.actions.cancel")}
                </button>
                <button className="button primary compact" type="button" onClick={() => void commit()} disabled={saving}>
                  <Save size={16} />
                  {t("actions.saveChanges")}
                </button>
              </>
            ) : (
              <button className="button secondary compact edit-provider-button" type="button" onClick={() => setDraft({ ...(config.customEnv ?? {}) })}>
                <Pencil size={16} />
                {t("settingsPage.actions.edit")}
              </button>
            )}
          </div>
        </header>
        <div className="advanced-environment-card">
          {entries.length > 0 ? (
            <div className="advanced-environment-list">
              {entries.map(([key]) => (
                <div className="advanced-environment-item" key={key}>
                  <code>{key}</code>
                  <span>••••••••</span>
                  <button type="button" onClick={() => removeEnv(key)} disabled={!editing || saving} aria-label={t("pilotDeckConfig.actions.remove")}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="advanced-environment-empty">
              {t("pilotDeckConfig.panels.customEnv.empty")}
            </div>
          )}

          <div className="advanced-environment-compose">
            <strong>{t("pilotDeckConfig.panels.customEnv.addVariable")}</strong>
            <div className="advanced-environment-form">
          <input
            value={newKey}
            onChange={(event) =>
              setNewKey(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))
            }
            placeholder="KEY_NAME"
            aria-label={t("pilotDeckConfig.panels.customEnv.variableName")}
            disabled={!editing || saving}
          />
          <span>=</span>
          <input
            ref={newValueInputRef}
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
            placeholder="value"
            type="password"
            aria-label={t("pilotDeckConfig.panels.customEnv.variableValue")}
            disabled={!editing || saving}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isImeEnterEvent(event)) addEntry();
            }}
          />
          <button
            className="button secondary advanced-environment-add"
            type="button"
            onClick={addEntry}
            disabled={
              !editing ||
              saving ||
              !newKey.trim() ||
              envMap[newKey.trim()] !== undefined
            }
          >
            <Plus size={16} />
            {t("pilotDeckConfig.panels.customEnv.add")}
          </button>
            </div>
          </div>

          <div className="advanced-environment-quick">
            <span>
            {t("pilotDeckConfig.panels.customEnv.quickAddKeys")}
            </span>
            <div>
            {unusedWellKnown.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => addWellKnown(entry.key)}
                title={entry.hint}
                disabled={!editing || saving}
              >
                <Plus size={14} />
                {entry.key}
              </button>
            ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
