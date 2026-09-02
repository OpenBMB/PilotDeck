import { Cloud, Pencil, Save } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PilotDeckConfig } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";

type ServiceSectionProps = {
  config: PilotDeckConfig;
  onSave: (next: PilotDeckConfig) => Promise<boolean>;
  saving: boolean;
};

type ServiceField = {
  id: string;
  path: string[];
  type: "text" | "number";
  value: string | number | undefined;
  translationKey: string;
};

export default function ServiceSection({
  config,
  onSave,
  saving,
}: ServiceSectionProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState<PilotDeckConfig | null>(null);
  const editing = draft !== null;
  const activeConfig = draft ?? config;
  const runtime = activeConfig.webui?.runtime ?? {};
  const fields: ServiceField[] = [
    { id: "host", path: ["webui", "runtime", "host"], type: "text", value: runtime.host, translationKey: "host" },
    { id: "serverPort", path: ["webui", "runtime", "serverPort"], type: "number", value: runtime.serverPort, translationKey: "serverPort" },
    { id: "workspacesRoot", path: ["webui", "runtime", "workspacesRoot"], type: "text", value: runtime.workspacesRoot, translationKey: "workspacesRoot" },
    { id: "vitePort", path: ["webui", "runtime", "vitePort"], type: "number", value: runtime.vitePort, translationKey: "vitePort" },
    { id: "apiTimeout", path: ["webui", "runtime", "apiTimeoutMs"], type: "number", value: runtime.apiTimeoutMs, translationKey: "apiTimeout" },
    { id: "databasePath", path: ["webui", "runtime", "databasePath"], type: "text", value: runtime.databasePath, translationKey: "databasePath" },
    { id: "proxyUrl", path: ["proxy", "url"], type: "text", value: activeConfig.proxy?.url, translationKey: "proxyUrl" },
    { id: "proxyNoProxy", path: ["proxy", "noProxy"], type: "text", value: activeConfig.proxy?.noProxy, translationKey: "proxyNoProxy" },
  ];

  const beginEdit = () =>
    setDraft(JSON.parse(JSON.stringify(config)) as PilotDeckConfig);

  const updateField = (field: ServiceField, rawValue: string) => {
    if (!draft) return;
    const value =
      field.type === "number"
        ? rawValue === ""
          ? undefined
          : Math.max(0, Number(rawValue))
        : rawValue;
    setDraft(patch(draft, field.path, value));
  };

  const commit = async () => {
    if (draft && (await onSave(draft))) setDraft(null);
  };

  return (
    <section className="advanced-system-section" aria-labelledby="advanced-service-title">
      <div className="advanced-settings-card">
        <header className="agent-retry-header advanced-card-header">
          <span className="agent-retry-icon"><Cloud size={19} /></span>
          <span>
            <strong id="advanced-service-title">
              {t("pilotDeckConfig.panels.runtime.title")}
            </strong>
            <small>{t("pilotDeckConfig.panels.runtime.description")}</small>
          </span>
          <div className="agent-retry-actions">
            {editing ? (
              <>
                <button className="button secondary compact" type="button" onClick={() => setDraft(null)} disabled={saving}>
                  {t("settingsPage.actions.cancel")}
                </button>
                <button className="button primary compact" type="button" onClick={() => void commit()} disabled={saving}>
                  <Save size={16} />
                  {t("actions.saveChanges")}
                </button>
              </>
            ) : (
              <button className="button secondary compact edit-provider-button" type="button" onClick={beginEdit}>
                <Pencil size={16} />
                {t("settingsPage.actions.edit")}
              </button>
            )}
          </div>
        </header>
        <div className="advanced-service-grid">
          {fields.map((field) => (
            <label className="advanced-service-field" htmlFor={`advanced-service-${field.id}`} key={field.id}>
              <div className="advanced-service-copy">
                <strong>{t(`pilotDeckConfig.panels.runtime.fields.${field.translationKey}.label`)}</strong>
                <p>{t(`pilotDeckConfig.panels.runtime.fields.${field.translationKey}.description`)}</p>
              </div>
              <input
                id={`advanced-service-${field.id}`}
                type={field.type}
                min={field.type === "number" ? 0 : undefined}
                value={field.value ?? ""}
                disabled={!editing || saving}
                onChange={(event) => updateField(field, event.target.value)}
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
