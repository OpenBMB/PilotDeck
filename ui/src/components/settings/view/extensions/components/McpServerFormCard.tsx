import { Code2, Globe2, Pencil, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../../lib/utils";
import type { McpServerForm } from "../types/mcp";
import { Field, KeyValueEditor, StringListEditor } from "./FormEditors";

type McpServerFormCardProps = {
  server: McpServerForm;
  editing: boolean;
  saving?: boolean;
  onChange: (patch: Partial<McpServerForm>) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onRemove: () => void;
};

export default function McpServerFormCard({
  server,
  editing,
  saving = false,
  onChange,
  onEdit,
  onCancel,
  onSave,
  onRemove,
}: McpServerFormCardProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="mcp-detail-panel">
      <header className="mcp-detail-header">
        <span className={cn("mcp-transport-icon", server.transport)}>
          {server.transport === "stdio" ? <Code2 size={19} /> : <Globe2 size={19} />}
        </span>
        <div className="mcp-detail-title">
          <div className="mcp-detail-title-line">
            {editing ? (
              <input
                className="mcp-inline-title-input"
                value={server.name}
                onChange={(event) => onChange({ name: event.target.value })}
                aria-label={t("mcpConfig.fields.name")}
              />
            ) : (
              <strong className="mcp-server-title">
                {server.name || t("mcpConfig.unnamed")}
              </strong>
            )}
            <span className={cn("mcp-detail-type", server.transport)}>
              {server.transport === "stdio" ? "STDIO" : "HTTP"}
            </span>
          </div>
          <small>
            {server.transport === "stdio"
              ? t("mcpConfig.localProcess")
              : t("mcpConfig.remoteService")}
          </small>
        </div>
        <div className="mcp-detail-actions">
          {editing ? (
            <>
              <button className="mcp-edit-server-button secondary" type="button" onClick={onCancel}>
                <X size={14} />
                {t("settingsPage.actions.cancel")}
              </button>
              <button
                className="mcp-edit-server-button primary"
                type="button"
                onClick={onSave}
                disabled={saving}
              >
                <Save size={14} />
                {t("settingsPage.actions.save")}
              </button>
            </>
          ) : (
            <>
              <button className="mcp-edit-server-button" type="button" onClick={onEdit}>
                <Pencil size={14} />
                {t("settingsPage.actions.edit")}
              </button>
              <button className="mcp-remove-server-button" type="button" onClick={onRemove}>
                <Trash2 size={15} />
                {t("pilotDeckConfig.actions.remove")}
              </button>
            </>
          )}
        </div>
      </header>

      <div className={cn("mcp-server-editor", editing ? "editing" : "readonly")}>
        {server.transport === "stdio" ? (
          <>
            <Field label={t("mcpConfig.fields.command")}>
              <input
                value={server.command}
                onChange={(event) => onChange({ command: event.target.value })}
                placeholder="npx、uvx 或可执行文件路径"
                disabled={!editing}
              />
            </Field>
            <StringListEditor
              label={t("mcpConfig.fields.args")}
              values={server.args}
              placeholder={t("mcpConfig.placeholders.arg")}
              addLabel={t("mcpConfig.actions.addArg")}
              onChange={(args) => onChange({ args })}
              disabled={!editing}
            />
            <KeyValueEditor
              label={t("mcpConfig.fields.env")}
              rows={server.env}
              keyPlaceholder={t("mcpConfig.placeholders.key")}
              valuePlaceholder={t("mcpConfig.placeholders.value")}
              addLabel={t("mcpConfig.actions.addEnv")}
              onChange={(env) => onChange({ env })}
              disabled={!editing}
            />
            <StringListEditor
              label={t("mcpConfig.fields.envPassThrough")}
              values={server.envPassThrough}
              placeholder="API_KEY"
              addLabel={t("mcpConfig.actions.addVariable")}
              onChange={(envPassThrough) => onChange({ envPassThrough })}
              disabled={!editing}
            />
            <div className="mcp-session-row">
              <div>
                <strong>{t("mcpConfig.fields.perSession")}</strong>
                <p>{t("mcpConfig.fields.perSessionHelp")}</p>
              </div>
              <button
                className={cn("route-switch", server.perSession && "on")}
                type="button"
                role="switch"
                aria-checked={server.perSession}
                aria-label={t("mcpConfig.fields.perSession")}
                onClick={() => onChange({ perSession: !server.perSession })}
                disabled={!editing}
              >
                <span />
              </button>
            </div>
          </>
        ) : (
          <>
            <Field label={t("mcpConfig.fields.url")}>
              <input
                value={server.url}
                onChange={(event) => onChange({ url: event.target.value })}
                placeholder="https://example.com/mcp"
                disabled={!editing}
              />
            </Field>
            <KeyValueEditor
              label={t("mcpConfig.fields.headers")}
              rows={server.headers}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ${env:MCP_TOKEN}"
              addLabel={t("mcpConfig.actions.addHeader")}
              onChange={(headers) => onChange({ headers })}
              disabled={!editing}
            />
            <div className="mcp-http-note" role="note">
              <ShieldCheck size={15} />
              {t("mcpConfig.credentialsNote")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
