import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { NumberInput } from "../../modelPool/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import { SettingsCard } from "../../../shared/view";

type ModelPricingEditorProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function ModelPricingEditor({
  config,
  onChange,
}: ModelPricingEditorProps) {
  const { t } = useTranslation("settings");
  const pricing = config.router?.stats?.modelPricing ?? {};
  const keys = Object.keys(pricing);
  const [newKey, setNewKey] = useState("");

  const setPricing = (
    key: string,
    field: "input" | "output" | "cacheRead",
    value: number | undefined,
  ) => {
    const entry = pricing[key] ?? {};
    onChange(
      patch(config, ["router", "stats", "modelPricing", key], {
        ...entry,
        [field]: value,
      }),
    );
  };

  const removePricing = (key: string) => {
    const next = { ...pricing };
    delete next[key];
    onChange(patch(config, ["router", "stats", "modelPricing"], next));
  };

  const addPricing = () => {
    const key = newKey.trim();
    if (!key || pricing[key]) return;
    onChange(
      patch(config, ["router", "stats", "modelPricing", key], {
        input: 0,
        output: 0,
      }),
    );
    setNewKey("");
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">
          {t("pilotDeckConfig.panels.router.pricing.title")}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.router.pricing.description")}
        </div>
      </div>

      {keys.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.router.pricing.empty")}
        </div>
      )}

      {keys.map((key) => {
        const entry = pricing[key] ?? {};
        return (
          <div
            key={key}
            className="space-y-2 rounded-lg border border-border bg-background/50 p-3"
          >
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">
                {key}
              </code>
              <button
                type="button"
                onClick={() => removePricing(key)}
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title={t("pilotDeckConfig.actions.remove")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">
                  {t("pilotDeckConfig.panels.router.pricing.inputPerM")}
                </span>
                <NumberInput
                  value={entry.input}
                  placeholder="0.50"
                  onChange={(v) => setPricing(key, "input", v)}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">
                  {t("pilotDeckConfig.panels.router.pricing.outputPerM")}
                </span>
                <NumberInput
                  value={entry.output}
                  placeholder="1.50"
                  onChange={(v) => setPricing(key, "output", v)}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">
                  {t("pilotDeckConfig.panels.router.pricing.cachePerM")}
                </span>
                <NumberInput
                  value={entry.cacheRead}
                  placeholder="0"
                  onChange={(v) => setPricing(key, "cacheRead", v)}
                />
              </label>
            </div>
          </div>
        );
      })}

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-foreground">
          {t("pilotDeckConfig.panels.router.pricing.addTitle")}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="provider/model-name"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeEnterEvent(e)) addPricing();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={addPricing}
            disabled={!newKey.trim()}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("pilotDeckConfig.panels.router.pricing.add")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
