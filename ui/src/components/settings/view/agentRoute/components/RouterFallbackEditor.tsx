import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { buildModelRefOptions, ensureModelRefConfigured, ensureModelRefsConfigured } from "../../agentModel/utils/modelRefs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import { SettingsCard } from "../../../shared/view";
import ModelRefInput from "./ModelRefInput";

type RouterFallbackEditorProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function RouterFallbackEditor({
  config,
  onChange,
}: RouterFallbackEditorProps) {
  const { t } = useTranslation("settings");
  const fallback = config.router?.fallback ?? {};
  const entries = Object.entries(fallback);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState("");

  const setChain = (scenario: string, chain: string[]) =>
    onChange(
      patch(
        ensureModelRefsConfigured(config, chain),
        ["router", "fallback", scenario],
        chain,
      ),
    );

  const removeChain = (scenario: string) => {
    const next = { ...fallback };
    delete next[scenario];
    onChange(patch(config, ["router", "fallback"], next));
  };

  const addChain = () => {
    const key = newKey.trim();
    if (!key || fallback[key]) return;
    const value = modelOpts[0]?.value ?? "";
    onChange(
      patch(
        ensureModelRefConfigured(config, value),
        ["router", "fallback", key],
        [value],
      ),
    );
    setNewKey("");
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">
          {t("pilotDeckConfig.panels.router.fallback.title")}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.router.fallback.description")}
        </div>
      </div>
      {entries.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.router.fallback.empty")}
        </div>
      )}
      {entries.map(([scenario, chain]) => (
        <div
          key={scenario}
          className="space-y-2 rounded-lg border border-border bg-background/50 p-3"
        >
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">
              {scenario}
            </code>
            <button
              type="button"
              onClick={() => removeChain(scenario)}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={t("pilotDeckConfig.actions.remove")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {(chain ?? []).map((model, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-[10px] font-semibold text-muted-foreground">
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <ModelRefInput
                    value={model}
                    options={modelOpts}
                    onChange={(v) => {
                      const next = [...chain];
                      next[idx] = v;
                      setChain(scenario, next);
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setChain(scenario, chain.filter((_, i) => i !== idx))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title={t("pilotDeckConfig.actions.removeModel")}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setChain(scenario, [...(chain ?? []), modelOpts[0]?.value ?? ""])}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              {t("pilotDeckConfig.panels.router.fallback.addModel")}
            </button>
          </div>
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="scenario name (e.g. default)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeEnterEvent(e)) addChain();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={addChain}
            disabled={!newKey.trim()}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("pilotDeckConfig.panels.router.fallback.add")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
