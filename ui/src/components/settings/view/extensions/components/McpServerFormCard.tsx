import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../shared/view/ui";
import { INPUT_CLASS } from "../utils/constants";
import type { McpServerForm } from "../types/mcp";
import {
  Field,
  KeyValueEditor,
  StringListEditor,
  ToggleButton,
} from "./FormEditors";

type McpServerFormCardProps = {
  server: McpServerForm;
  onChange: (patch: Partial<McpServerForm>) => void;
  onRemove: () => void;
};

export default function McpServerFormCard({
  server,
  onChange,
  onRemove,
}: McpServerFormCardProps) {
  const { t } = useTranslation("settings");
  const summary =
    server.transport === "stdio"
      ? [server.command, ...server.args].filter(Boolean).join(" ")
      : server.url;
  const shouldOpenByDefault =
    server.name.startsWith("new-stdio-server") ||
    server.name.startsWith("new-remote-server");
  const [isOpen, setIsOpen] = useState(shouldOpenByDefault);

  return (
    <details
      className="overflow-hidden rounded-lg border border-border bg-background"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none px-4 py-3 transition-colors hover:bg-accent/25 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">
                {server.name || t("mcpConfig.unnamed")}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase text-muted-foreground">
                {server.transport === "stdio" ? "STDIO" : t("mcpConfig.transport.http")}
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {summary || t("mcpConfig.noSummary")}
            </div>
          </div>
          <span className="text-xs font-medium text-muted-foreground">
            {t("mcpConfig.expand")}
          </span>
        </div>
      </summary>

      <div className="space-y-4 border-t border-border p-4">
        <Field label={t("mcpConfig.fields.name")}>
          <input
            value={server.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="MCP server name"
            className={INPUT_CLASS}
          />
        </Field>

        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-muted/40 p-1">
          <ToggleButton
            active={server.transport === "stdio"}
            onClick={() => onChange({ transport: "stdio" })}
          >
            STDIO
          </ToggleButton>
          <ToggleButton
            active={server.transport === "http"}
            onClick={() => onChange({ transport: "http" })}
          >
            {t("mcpConfig.transport.http")}
          </ToggleButton>
        </div>

        {server.transport === "stdio" ? (
          <div className="space-y-4">
            <Field label={t("mcpConfig.fields.command")}>
              <input
                value={server.command}
                onChange={(event) => onChange({ command: event.target.value })}
                placeholder="npx"
                className={INPUT_CLASS}
              />
            </Field>

            <StringListEditor
              label={t("mcpConfig.fields.args")}
              values={server.args}
              placeholder="-y"
              addLabel={t("mcpConfig.actions.addArg")}
              onChange={(args) => onChange({ args })}
            />

            <KeyValueEditor
              label={t("mcpConfig.fields.env")}
              rows={server.env}
              keyPlaceholder={t("mcpConfig.placeholders.key")}
              valuePlaceholder={t("mcpConfig.placeholders.value")}
              addLabel={t("mcpConfig.actions.addEnv")}
              onChange={(env) => onChange({ env })}
            />

            <StringListEditor
              label={t("mcpConfig.fields.envPassThrough")}
              values={server.envPassThrough}
              placeholder="GITHUB_TOKEN"
              addLabel={t("mcpConfig.actions.addVariable")}
              onChange={(envPassThrough) => onChange({ envPassThrough })}
            />

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <span>
                <span className="block text-sm font-medium text-foreground">
                  {t("mcpConfig.fields.perSession")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("mcpConfig.fields.perSessionHelp")}
                </span>
              </span>
              <input
                type="checkbox"
                checked={server.perSession}
                onChange={(event) => onChange({ perSession: event.target.checked })}
                className="h-4 w-4"
              />
            </label>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label={t("mcpConfig.fields.url")}>
              <input
                value={server.url}
                onChange={(event) => onChange({ url: event.target.value })}
                placeholder="https://example.com/mcp"
                className={INPUT_CLASS}
              />
            </Field>
            <KeyValueEditor
              label={t("mcpConfig.fields.headers")}
              rows={server.headers}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ${env:MCP_TOKEN}"
              addLabel={t("mcpConfig.actions.addHeader")}
              onChange={(headers) => onChange({ headers })}
            />
          </div>
        )}
      </div>

      <div className="flex justify-end border-t border-border bg-muted/20 px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
          {t("pilotDeckConfig.actions.remove")}
        </Button>
      </div>
    </details>
  );
}
