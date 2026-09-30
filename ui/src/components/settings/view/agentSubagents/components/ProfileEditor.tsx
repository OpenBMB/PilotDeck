import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormRow, Select, TextAreaInput, TextInput } from "../../../shared/components/Inputs";
import { SettingsToggle } from "../../../shared/view";
import type { SubagentProfileConfig } from "../../../../../../../src/agent/sub/subagentProfiles.js";
import type { ProfileDraftErrors } from "../utils/profileConfig";
import type { ProfileRow } from "./ProfileList";

type ProfileEditorProps = {
  row: ProfileRow;
  idValue: string;
  override: SubagentProfileConfig | undefined;
  presetTools: readonly string[] | undefined;
  presetReadOnly: boolean;
  isNew: boolean;
  modelOptions: Array<{ value: string; label: string }>;
  errors: ProfileDraftErrors;
  onIdChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onModelChange: (ref: string) => void;
  onToggleTool: (tool: string) => void;
  onAddTool: (tool: string) => void;
  onReadOnlyChange: (next: boolean) => void;
  onEnabledChange: (next: boolean) => void;
  onReset: () => void;
  onDelete: () => void;
};

const prefix = "pilotDeckConfig.panels.agentSubagents";

export default function ProfileEditor({
  row,
  idValue,
  override,
  presetTools,
  presetReadOnly,
  isNew,
  modelOptions,
  errors,
  onIdChange,
  onDescriptionChange,
  onModelChange,
  onToggleTool,
  onAddTool,
  onReadOnlyChange,
  onEnabledChange,
  onReset,
  onDelete,
}: ProfileEditorProps) {
  const { t } = useTranslation("settings");
  const [toolDraft, setToolDraft] = useState("");

  const isReadOnlyPreset = row.builtIn && presetReadOnly;
  const toolOptions = useMemo(() => {
    if (isReadOnlyPreset && presetTools) {
      return [...presetTools, "agent"];
    }
    return Array.from(new Set(["*", "read_file", "grep", "glob", "bash", "write_file", "edit_file", "web_search", "web_fetch", "agent", ...row.tools]));
  }, [isReadOnlyPreset, presetTools, row.tools]);

  const errorLine = (key?: string) =>
    key ? (
      <p role="alert" className="mt-1 text-[11px] text-destructive">
        {t(key)}
      </p>
    ) : null;

  return (
    <div className="divide-y divide-border">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <h4 className="text-[13px] font-medium text-foreground">{t(`${prefix}.editor.title`)}</h4>
        <span className="font-mono text-[12px] text-muted-foreground">{row.id}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {row.builtIn && override && Object.keys(override).length > 0 ? (
            <button
              type="button"
              onClick={onReset}
              aria-label={t(`${prefix}.editor.resetAria`)}
              className="rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {t(`${prefix}.editor.reset`)}
            </button>
          ) : null}
          {!row.builtIn ? (
            <button
              type="button"
              onClick={onDelete}
              className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
            >
              {t(`${prefix}.editor.delete`)}
            </button>
          ) : null}
        </div>
      </div>

      <FormRow announceChanges={false} label={t(`${prefix}.editor.id.label`)} description={isNew ? t(`${prefix}.editor.id.description`) : undefined}>
        {isNew ? (
          <div>
            <TextInput
              value={idValue}
              onChange={onIdChange}
              ariaLabel={t(`${prefix}.editor.id.label`)}
              placeholder="my-role"
              monospace
            />
            {errorLine(errors.id)}
          </div>
        ) : (
          <span className="font-mono text-[13px] text-muted-foreground">{row.id}</span>
        )}
      </FormRow>

      <FormRow announceChanges={false} label={t(`${prefix}.editor.description.label`)} description={t(`${prefix}.editor.description.description`)}>
        <div>
          <TextAreaInput
            value={row.description}
            onChange={onDescriptionChange}
            placeholder={t(`${prefix}.editor.description.placeholder`)}
            ariaLabel={t(`${prefix}.editor.description.label`)}
            className="min-h-[64px] font-sans text-[13px]"
          />
          {errorLine(errors.description)}
        </div>
      </FormRow>

      <FormRow announceChanges={false} label={t(`${prefix}.editor.model.label`)} description={t(`${prefix}.editor.model.description`)}>
        <div>
          <Select
            value={row.model ?? ""}
            onChange={onModelChange}
            options={[{ value: "", label: t(`${prefix}.editor.model.inherit`) }, ...modelOptions]}
            ariaLabel={t(`${prefix}.editor.model.label`)}
          />
          {errorLine(errors.model)}
        </div>
      </FormRow>

      <FormRow announceChanges={false} label={t(`${prefix}.editor.tools.label`)} description={t(`${prefix}.editor.tools.description`)}>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {toolOptions.map((tool) => (
              <label
                key={tool}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground hover:bg-accent/40"
              >
                <input
                  type="checkbox"
                  checked={row.tools.includes("*") || row.tools.includes(tool)}
                  disabled={tool !== "*" && row.tools.includes("*")}
                  onChange={() => onToggleTool(tool)}
                  aria-label={tool === "*" ? t(`${prefix}.editor.tools.all`) : tool}
                  className="h-3.5 w-3.5 rounded border-border"
                />
                <span className="truncate font-mono">{tool === "*" ? t(`${prefix}.editor.tools.all`) : tool}</span>
              </label>
            ))}
          </div>
          {!isReadOnlyPreset && !row.tools.includes("*") ? (
            <div className="flex items-center gap-1.5">
              <TextInput value={toolDraft} onChange={setToolDraft} placeholder={t(`${prefix}.editor.tools.customPlaceholder`)} monospace />
              <button
                type="button"
                onClick={() => {
                  onAddTool(toolDraft);
                  setToolDraft("");
                }}
                disabled={toolDraft.trim().length === 0}
                className="shrink-0 rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t(`${prefix}.editor.tools.add`)}
              </button>
            </div>
          ) : null}
          {row.tools.length === 0 ? (
            <p className="text-[11px] text-destructive">{t(`${prefix}.editor.tools.empty`)}</p>
          ) : null}
          {isReadOnlyPreset ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{t(`${prefix}.editor.tools.narrowNote`)}</p>
          ) : row.id === "general-purpose" ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{t(`${prefix}.editor.tools.generalNote`)}</p>
          ) : null}
          {!isReadOnlyPreset && row.tools.includes("agent") ? (
            <p className="text-[11px] leading-4 text-muted-foreground">{t(`${prefix}.editor.tools.agentNote`)}</p>
          ) : null}
          {errorLine(errors.tools)}
        </div>
      </FormRow>

      <FormRow announceChanges={false} label={t(`${prefix}.editor.readOnly.label`)} description={t(`${prefix}.editor.readOnly.description`)}>
        <SettingsToggle
          checked={row.readOnly}
          onChange={onReadOnlyChange}
          disabled={isReadOnlyPreset}
          ariaLabel={t(`${prefix}.editor.readOnly.label`)}
          suppressNextSaveToast
        />
      </FormRow>

      <FormRow announceChanges={false} label={t(`${prefix}.editor.enabled.label`)} description={t(`${prefix}.editor.enabled.description`)}>
        <SettingsToggle
          checked={row.enabled}
          onChange={onEnabledChange}
          ariaLabel={t(`${prefix}.editor.enabled.label`)}
          suppressNextSaveToast
        />
      </FormRow>
    </div>
  );
}
