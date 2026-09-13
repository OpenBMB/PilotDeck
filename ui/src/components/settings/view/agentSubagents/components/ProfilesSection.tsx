import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_CUSTOM_TOOLS,
  MAX_SUBAGENT_DEPTH,
  formatSubagentCatalog,
  parseSubagentProfiles,
  resolveSubagentProfiles,
  type ResolvedSubagentProfile,
  type SubagentProfileConfig,
} from "../../../../../../../src/agent/sub/subagentProfiles.js";
import { configToYamlString } from "../../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../../modelPool/types";
import { buildModelRefOptions, ensureModelRefConfigured } from "../../agentModel/utils/modelRefs";
import { FieldSaveModeProvider, FormRow, Select } from "../../../shared/components/Inputs";
import { ConfigSaveError, PageSectionHeader, SettingsCard } from "../../../shared/view";
import {
  getMaxDepth,
  getProfiles,
  makeCustomProfile,
  newCustomProfileId,
  sanitizeTools,
  validateMaxDepth,
  validateProfileId,
  validateProfileDraft,
  withMaxDepth,
  withProfiles,
  type ProfileDraftErrors,
} from "../utils/profileConfig";
import ProfileList, { type ProfileRow } from "./ProfileList";
import ProfileEditor from "./ProfileEditor";
import SubagentsPreview from "./SubagentsPreview";

const prefix = "pilotDeckConfig.panels.agentSubagents";
const DEFAULT_DEPTH = 1;

type ProfilesSectionProps = {
  config: PilotDeckConfig;
  saving: boolean;
  onSave: (
    next: PilotDeckConfig,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

function toRows(resolved: readonly ResolvedSubagentProfile[]): ProfileRow[] {
  return resolved.map((profile) => ({
    id: String(profile.id),
    description: profile.description,
    model: profile.model,
    tools: [...profile.allowedTools],
    enabled: profile.enabled,
    builtIn: profile.builtIn,
    readOnly: profile.isReadOnly,
  }));
}

export default function ProfilesSection({ config, saving, onSave }: ProfilesSectionProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraftState] = useState<PilotDeckConfig>(config);
  const locallyEdited = useRef(false);
  const savePending = useRef(false);
  const latestConfig = useRef(config);
  latestConfig.current = config;
  const setDraft = (next: PilotDeckConfig | ((previous: PilotDeckConfig) => PilotDeckConfig)) => {
    locallyEdited.current = true;
    setDraftState(next);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const dirty = Object.keys(pendingIds).length > 0 || configToYamlString(draft) !== configToYamlString(config);

  // Follow external config updates (and post-save refreshes) only while the
  // local draft is clean, so a failed save never wipes the user's edits.
  useEffect(() => {
    if (!locallyEdited.current) setDraftState(config);
  }, [config]);

  const draftProfiles = useMemo(() => getProfiles(draft) ?? {}, [draft]);
  const presets = useMemo(() => resolveSubagentProfiles(), []);
  const presetById = useMemo(
    () => new Map(presets.map((preset) => [String(preset.id), preset])),
    [presets],
  );

  const parseError = useMemo(() => {
    try {
      parseSubagentProfiles(getProfiles(config));
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }, [config]);

  // The draft may intentionally hold incomplete roles mid-edit (e.g. a custom
  // role right after "Add", before its description exists) — the shared
  // resolver rejects those. Fall back to builtin-only resolution for the list
  // and mark the preview as pending until the draft is valid again.
  const { rows, previewInvalid } = useMemo(() => {
    try {
      return { rows: toRows(resolveSubagentProfiles(draftProfiles)), previewInvalid: false };
    } catch {
      const builtinOnly: Record<string, SubagentProfileConfig> = {};
      for (const [id, value] of Object.entries(draftProfiles)) {
        if (presetById.has(id)) builtinOnly[id] = value;
      }
      const rows = toRows(resolveSubagentProfiles(builtinOnly));
      for (const [id, value] of Object.entries(draftProfiles)) {
        if (presetById.has(id)) continue;
        const model =
          typeof value.model === "string" && value.model !== "inherit" && value.model.trim().length > 0
            ? value.model
            : undefined;
        rows.push({
          id,
          description: typeof value.description === "string" ? value.description : "",
          model,
          tools: sanitizeTools(value.tools) ?? [...DEFAULT_CUSTOM_TOOLS],
          enabled: value.enabled !== false,
          builtIn: false,
          readOnly: value.readOnly !== false,
        });
      }
      return { rows, previewInvalid: true };
    }
  }, [draftProfiles, presetById]);

  const preview = useMemo(() => {
    if (previewInvalid || Object.keys(pendingIds).length > 0 || getMaxDepth(draft) === 0) return "";
    try {
      return formatSubagentCatalog(resolveSubagentProfiles(parseSubagentProfiles(draftProfiles)));
    } catch {
      return "";
    }
  }, [draft, draftProfiles, previewInvalid, pendingIds]);

  useEffect(() => {
    if (selectedId && rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows.length > 0 ? rows[0].id : null);
  }, [rows, selectedId]);

  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const selectedOverride = selectedId ? draftProfiles[selectedId] : undefined;
  const modelOptions = useMemo(() => buildModelRefOptions(draft), [draft]);
  const modelRefValues = useMemo(() => modelOptions.map((option) => option.value), [modelOptions]);

  const editorErrors = useMemo<ProfileDraftErrors>(() => {
    if (!selectedRow || !selectedId) return {};
    const preset = presetById.get(selectedId);
    return validateProfileDraft({
      id: pendingIds[selectedId] ?? selectedId,
      profile: draftProfiles[selectedId] ?? {},
      otherIds: [...presetById.keys(), ...Object.keys(draftProfiles)].filter((id) => id !== selectedId),
      configuredModelRefs: modelRefValues,
      idEditable: newIds.has(selectedId),
      descriptionRequired: !selectedRow.builtIn,
      permittedTools: preset && preset.isReadOnly ? preset.allowedTools : undefined,
    });
  }, [selectedRow, selectedId, draftProfiles, presetById, modelRefValues, newIds, pendingIds]);

  const depthError = validateMaxDepth(getMaxDepth(draft), MAX_SUBAGENT_DEPTH);
  const invalidProfiles = useMemo(() => {
    try { parseSubagentProfiles(draftProfiles); return false; }
    catch { return true; }
  }, [draftProfiles]);
  const hasErrors = Object.keys(editorErrors).length > 0 || depthError !== null
    || invalidProfiles || Object.keys(pendingIds).length > 0;

  const withOverride = (
    cfg: PilotDeckConfig,
    id: string,
    next: SubagentProfileConfig | undefined,
  ): PilotDeckConfig => {
    const profiles = { ...(getProfiles(cfg) ?? {}) };
    if (!next || Object.keys(next).length === 0) {
      delete profiles[id];
    } else {
      profiles[id] = next;
    }
    return withProfiles(cfg, profiles);
  };

  const patchOverrideField = (id: string, field: string, value: unknown) => {
    setDraft((cfg) => {
      const next: Record<string, unknown> = { ...(getProfiles(cfg) ?? {})[id] };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return withOverride(cfg, id, next as SubagentProfileConfig);
    });
  };

  const effectiveToolsOf = (cfg: PilotDeckConfig, id: string): string[] => {
    const current = (getProfiles(cfg) ?? {})[id];
    const preset = presetById.get(id);
    return sanitizeTools(current?.tools) ?? [...(preset?.allowedTools ?? DEFAULT_CUSTOM_TOOLS)];
  };

  const handleToggleTool = (id: string, tool: string) => {
    setDraft((cfg) => {
      const current = (getProfiles(cfg) ?? {})[id];
      const effective = effectiveToolsOf(cfg, id);
      const nextTools = effective.includes(tool)
        ? effective.filter((entry) => entry !== tool)
        : [...effective, tool];
      const next: Record<string, unknown> = { ...(current ?? {}) };
      const presetTools = presetById.get(id)?.allowedTools;
      const sameAsPreset =
        presetTools !== undefined &&
        presetTools.length === nextTools.length &&
        [...presetTools].sort().join("\u0000") === [...nextTools].sort().join("\u0000");
      if (sameAsPreset) delete next.tools;
      else next.tools = nextTools;
      return withOverride(cfg, id, next as SubagentProfileConfig);
    });
  };

  const handleAddTool = (id: string, rawTool: string) => {
    const tool = rawTool.trim();
    if (!tool) return;
    setDraft((cfg) => {
      const current = (getProfiles(cfg) ?? {})[id];
      const effective = effectiveToolsOf(cfg, id);
      if (effective.includes(tool)) return cfg;
      const next: Record<string, unknown> = { ...(current ?? {}) };
      next.tools = [...effective, tool];
      return withOverride(cfg, id, next as SubagentProfileConfig);
    });
  };

  const handleModelChange = (id: string, ref: string) => {
    setDraft((cfg) => {
      const withEntry = ref ? ensureModelRefConfigured(cfg, ref) : cfg;
      const next: Record<string, unknown> = { ...(getProfiles(withEntry) ?? {})[id] };
      if (!ref) delete next.model;
      else next.model = ref;
      return withOverride(withEntry, id, next as SubagentProfileConfig);
    });
  };

  const handleIdChange = (oldId: string, nextRaw: string) => {
    locallyEdited.current = true;
    const nextId = nextRaw;
    const otherIds = [...presetById.keys(), ...Object.keys(draftProfiles)].filter(id => id !== oldId);
    if (validateProfileId(nextId, otherIds)) {
      setPendingIds(current => ({ ...current, [oldId]: nextRaw }));
      return;
    }
    setPendingIds(current => {
      const next = { ...current };
      delete next[oldId];
      return next;
    });
    if (nextId === oldId) return;
    setDraft((cfg) => {
      const profiles = { ...(getProfiles(cfg) ?? {}) };
      if (
        !Object.prototype.hasOwnProperty.call(profiles, oldId) ||
        Object.prototype.hasOwnProperty.call(profiles, nextId)
      ) {
        return cfg;
      }
      profiles[nextId] = profiles[oldId];
      delete profiles[oldId];
      return withProfiles(cfg, profiles);
    });
    setNewIds((prev) => {
      if (!prev.has(oldId)) return prev;
      const next = new Set(prev);
      next.delete(oldId);
      next.add(nextId);
      return next;
    });
    setSelectedId(nextId);
  };

  const handleAdd = () => {
    const id = newCustomProfileId(Object.keys(draftProfiles));
    setDraft((cfg) => {
      const profiles = { ...(getProfiles(cfg) ?? {}) };
      profiles[id] = makeCustomProfile("");
      return withProfiles(cfg, profiles);
    });
    setNewIds((prev) => new Set(prev).add(id));
    setSelectedId(id);
    setFormError(null);
  };

  const handleDelete = (id: string) => {
    setPendingIds(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDraft((cfg) => withOverride(cfg, id, undefined));
    setNewIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelectedId(null);
  };

  const handleCancel = () => {
    setPendingIds({});
    locallyEdited.current = false;
    setDraftState(config);
    setNewIds(new Set());
    setFormError(null);
    setSelectedId(null);
  };

  const handleSave = async () => {
    if (saving || savePending.current || !dirty || hasErrors) return;
    savePending.current = true;
    setFormError(null);
    try {
      const result = await onSave(draft);
      if (result && result.ok === false) {
        setFormError(result.error || t(`${prefix}.saveFailed`));
      } else {
        locallyEdited.current = false;
        setDraftState(latestConfig.current);
        setNewIds(new Set());
      }
    } catch (caught) {
      setFormError(
        caught instanceof Error ? caught.message : t(`${prefix}.saveFailed`),
      );
    } finally {
      savePending.current = false;
    }
  };

  const maxDepthValue = String(getMaxDepth(draft) ?? DEFAULT_DEPTH);
  const depthOptions = Array.from({ length: MAX_SUBAGENT_DEPTH + 1 }, (_, value) => ({
    value: String(value),
    label: String(value),
  }));

  return (
    <FieldSaveModeProvider mode="immediate">
      <fieldset disabled={saving} className="min-w-0 space-y-4 border-0 p-0">
        <PageSectionHeader description={t(`${prefix}.description`)} />
        {parseError ? <ConfigSaveError error={parseError} /> : null}

        <SettingsCard>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <h3 className="text-[13px] font-medium text-foreground">{t(`${prefix}.listTitle`)}</h3>
              <p className="text-[11px] text-muted-foreground">
                {t(`${prefix}.count`, { count: rows.length })}
              </p>
            </div>
            <button
              type="button"
              onClick={handleAdd}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-[12px] text-primary transition-colors hover:bg-primary/20"
            >
              <span className="text-base leading-none" aria-hidden="true">+</span>
              {t(`${prefix}.addProfile`)}
            </button>
          </div>
          <div className="px-4 pb-3">
            <ProfileList
              rows={rows}
              selectedId={selectedId}
              hasOverride={(id) => Object.keys(draftProfiles[id] ?? {}).length > 0}
              isNew={(id) => newIds.has(id)}
              onSelect={setSelectedId}
              onDelete={handleDelete}
              onReset={(id) => setDraft((cfg) => withOverride(cfg, id, undefined))}
            />
          </div>
        </SettingsCard>

        <SettingsCard divided>
          {selectedRow && selectedId ? (
            <ProfileEditor
              row={selectedRow}
              idValue={pendingIds[selectedId] ?? selectedId}
              override={selectedOverride}
              presetTools={presetById.get(selectedId)?.allowedTools}
              presetReadOnly={presetById.get(selectedId)?.isReadOnly ?? false}
              isNew={newIds.has(selectedId)}
              modelOptions={modelOptions}
              errors={editorErrors}
              onIdChange={(next) => handleIdChange(selectedId, next)}
              onDescriptionChange={(next) =>
                patchOverrideField(selectedId, "description", next.length === 0 ? undefined : next)
              }
              onModelChange={(ref) => handleModelChange(selectedId, ref)}
              onToggleTool={(tool) => handleToggleTool(selectedId, tool)}
              onAddTool={(tool) => handleAddTool(selectedId, tool)}
              onReadOnlyChange={(next) => patchOverrideField(selectedId, "readOnly", next)}
              onEnabledChange={(next) => patchOverrideField(selectedId, "enabled", next)}
              onReset={() => setDraft((cfg) => withOverride(cfg, selectedId, undefined))}
              onDelete={() => handleDelete(selectedId)}
            />
          ) : (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] font-medium text-foreground">{t(`${prefix}.editor.emptyTitle`)}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{t(`${prefix}.editor.emptyDescription`)}</p>
            </div>
          )}
        </SettingsCard>

        <SettingsCard divided>
          <FormRow
            announceChanges={false}
            label={t(`${prefix}.maxDepth.label`)}
            description={t(`${prefix}.maxDepth.description`)}
          >
            <div>
              <Select
                value={maxDepthValue}
                options={depthOptions}
                onChange={(next) =>
                  setDraft((cfg) => withMaxDepth(cfg, Number(next)))
                }
                ariaLabel={t(`${prefix}.maxDepth.label`)}
              />
              {depthError ? (
                <p role="alert" className="mt-1 text-[11px] text-destructive">
                  {t(depthError)}
                </p>
              ) : null}
            </div>
          </FormRow>
          <div className="space-y-1.5 px-4 py-3">
            {(["depth", "permissions", "selection"] as const).map((key) => (
              <p
                key={key}
                className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground"
              >
                <span className="shrink-0 text-primary" aria-hidden="true">ⓘ</span>
                {t(`${prefix}.help.${key}`)}
              </p>
            ))}
          </div>
        </SettingsCard>

        <SubagentsPreview text={preview} invalid={previewInvalid || invalidProfiles || Object.keys(pendingIds).length > 0} disabled={getMaxDepth(draft) === 0} />

        <div className="rounded-xl border border-border bg-card/50 px-4 py-3">
          {dirty ? (
            <p className="text-[11px] text-muted-foreground">{t(`${prefix}.dirtyHint`)}</p>
          ) : null}
          <ConfigSaveError error={formError} />
          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              disabled={!dirty}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t(`${prefix}.cancel`)}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !dirty || hasErrors}
              className="rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? t("pilotDeckConfig.actions.saving") : t(`${prefix}.save`)}
            </button>
          </div>
        </div>
      </fieldset>
    </FieldSaveModeProvider>
  );
}
