import { Info, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { SettingsCard } from "../../../shared/view";
import type { PilotDeckConfig } from "../../modelPool/types";
import { FormRow, SecretTextInput } from "../../../shared/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import { isMaskedSecret } from "../../modelPool/utils/providerRefs";
import { WELL_KNOWN_ENV_KEYS } from "../utils/constants";

type CustomEnvSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function CustomEnvSection({ config, onChange }: CustomEnvSectionProps) {
  const { t } = useTranslation("settings");
  const envMap = config.customEnv ?? {};
  const entries = Object.entries(envMap);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const setEnv = (key: string, value: string) => {
    onChange(patch(config, ["customEnv", key], value));
  };

  const removeEnv = (key: string) => {
    const next = { ...envMap };
    delete next[key];
    onChange(patch(config, ["customEnv"], next));
  };

  const addEntry = () => {
    const key = newKey.trim();
    if (!key) return;
    onChange(patch(config, ["customEnv", key], newValue));
    setNewKey("");
    setNewValue("");
  };

  const addWellKnown = (key: string) => {
    if (envMap[key] !== undefined) return;
    onChange(patch(config, ["customEnv", key], ""));
  };

  const unusedWellKnown = WELL_KNOWN_ENV_KEYS.filter(
    (entry) => envMap[entry.key] === undefined,
  );

  return (
    <SettingsCard className="space-y-3 p-4">
      {entries.map(([key, value]) => {
        const masked = isMaskedSecret(value);
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center gap-2">
              <input
                value={key}
                readOnly
                className="w-[200px] shrink-0 rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground outline-none"
              />
              <span className="text-muted-foreground">=</span>
              <SecretTextInput
                value={value}
                placeholder={
                  masked
                    ? t("pilotDeckConfig.panels.customEnv.existingValueKept")
                    : "value"
                }
                monospace
                className="min-w-0 flex-1"
                onChange={(next) => setEnv(key, next)}
              />
              <button
                type="button"
                onClick={() => removeEnv(key)}
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title={t("pilotDeckConfig.actions.remove")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {masked ? (
              <div className="ml-[216px] flex items-center gap-1 text-[11px] text-muted-foreground">
                <Info className="h-3 w-3" />
                {t("pilotDeckConfig.panels.customEnv.valueHidden")}
              </div>
            ) : null}
          </div>
        );
      })}

      {entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.customEnv.empty")}
        </div>
      ) : null}

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-foreground">
          {t("pilotDeckConfig.panels.customEnv.addVariable")}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(event) =>
              setNewKey(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))
            }
            placeholder="KEY_NAME"
            className="w-[200px] shrink-0 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <span className="text-muted-foreground">=</span>
          <input
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
            placeholder="value"
            type="password"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isImeEnterEvent(event)) addEntry();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={addEntry}
            disabled={!newKey.trim()}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("pilotDeckConfig.panels.customEnv.add")}
          </Button>
        </div>
      </div>

      {unusedWellKnown.length > 0 ? (
        <div className="border-t border-border pt-3">
          <div className="mb-2 text-xs text-muted-foreground">
            {t("pilotDeckConfig.panels.customEnv.quickAddKeys")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {unusedWellKnown.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => addWellKnown(entry.key)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
                title={entry.hint}
              >
                <Plus className="h-3 w-3" />
                {entry.key}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </SettingsCard>
  );
}
