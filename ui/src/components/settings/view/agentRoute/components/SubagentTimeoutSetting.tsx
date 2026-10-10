import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConfigSaveResult } from "../../../../../hooks/usePilotDeckConfig";
import type { PilotDeckConfig } from "../../modelPool/types";

export type SaveRouteConfig = (
  next: PilotDeckConfig,
) => void | ConfigSaveResult | Promise<void | ConfigSaveResult>;

const PREFIX = "pilotDeckConfig.panels.agents.subagents";
const MIN_SECONDS = 0.001;
const MAX_SECONDS = 2147483.647;

export default function SubagentTimeoutSetting({
  config,
  onSave,
}: {
  config: PilotDeckConfig;
  onSave: SaveRouteConfig;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const timeoutMs = config.agent?.subagents?.timeoutMs;
  const value = timeoutMs === undefined ? "" : String(timeoutMs / 1000);
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badInput, setBadInput] = useState(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const seconds = Number(draft);
  const valid = !badInput && (draft === "" || (
    Number.isFinite(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS
  ));
  // The config controller retains its optimistic raw draft after ambiguous
  // network/server failures. Allow a retry even when that draft matches ours.
  const canSave = valid && (draft !== value || error !== null) && !saving;

  const cancel = () => {
    if (savingRef.current) return;
    setDraft(value);
    setBadInput(false);
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    if (inputRef.current?.validity.badInput) {
      setBadInput(true);
      return;
    }
    if (!canSave || savingRef.current) return;
    const subagents = { ...config.agent?.subagents };
    if (draft === "") delete subagents.timeoutMs;
    else subagents.timeoutMs = Math.round(seconds * 1000);
    const agent: NonNullable<PilotDeckConfig["agent"]> = { ...config.agent, subagents };
    if (Object.keys(subagents).length === 0) delete agent.subagents;
    const next: PilotDeckConfig = { ...config, agent };
    if (Object.keys(agent).length === 0) delete next.agent;

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(next);
      if (result && !result.ok) {
        setError(result.error);
      } else {
        setEditing(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(`${PREFIX}.timeoutSaveFailed`));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="route-subagent-model-copy">
        <label htmlFor={id}>{t(`${PREFIX}.timeoutLabel`)}</label>
        <p id={`${id}-description`}>{t(`${PREFIX}.timeoutDescription`)}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="number"
          min={MIN_SECONDS}
          max={MAX_SECONDS}
          step={0.001}
          value={draft}
          placeholder="3600"
          readOnly={!editing}
          disabled={saving}
          aria-describedby={`${id}-description${!valid ? ` ${id}-invalid` : ""}`}
          aria-invalid={!valid}
          onInput={(event) => setBadInput(event.currentTarget.validity.badInput)}
          onChange={(event) => {
            setDraft(event.target.value);
            setBadInput(event.target.validity.badInput);
          }}
          onKeyDown={(event) => {
            if (!editing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground read-only:bg-muted/40 read-only:text-muted-foreground disabled:opacity-50"
        />
        {editing ? (
          <>
            <button type="button" disabled={saving} onClick={cancel} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50">
              {t("settingsPage.actions.cancel")}
            </button>
            <button type="button" disabled={!canSave} onClick={() => void save()} className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary disabled:opacity-50">
              {t("settingsPage.actions.save")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="rounded border border-border px-2 py-1 text-xs">
            {t("settingsPage.actions.edit")}
          </button>
        )}
      </div>
      {!valid ? <p id={`${id}-invalid`} role="alert" className="mt-2 text-xs text-destructive">{t(`${PREFIX}.timeoutInvalid`)}</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
