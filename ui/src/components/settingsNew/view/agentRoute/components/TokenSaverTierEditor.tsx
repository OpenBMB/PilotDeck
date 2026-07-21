import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { buildModelRefOptions, ensureModelRefConfigured } from "../../agentModel/utils/modelRefs";
import { TextAreaInput } from "../../../shared/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import { DEFAULT_TIERS } from "../utils/router";
import ModelRefInput from "./ModelRefInput";

type TokenSaverTierEditorProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function TokenSaverTierEditor({
  config,
  onChange,
}: TokenSaverTierEditorProps) {
  const { t } = useTranslation("settings");
  const tiers = config.router?.tokenSaver?.tiers ?? {};
  const entries = Object.entries(tiers);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState("");

  const setTier = (key: string, field: "model" | "description", value: string) =>
    onChange(
      patch(
        field === "model" ? ensureModelRefConfigured(config, value) : config,
        ["router", "tokenSaver", "tiers", key, field],
        value,
      ),
    );

  const removeTier = (key: string) => {
    const next = { ...tiers };
    delete next[key];
    onChange(patch(config, ["router", "tokenSaver", "tiers"], next));
  };

  const addTier = () => {
    const key = newKey.trim();
    if (!key || tiers[key]) return;
    const preset = DEFAULT_TIERS[key as keyof typeof DEFAULT_TIERS];
    const model = modelOpts[0]?.value ?? "";
    onChange(
      patch(
        ensureModelRefConfigured(config, model),
        ["router", "tokenSaver", "tiers", key],
        { model, description: preset?.description ?? "" },
      ),
    );
    setNewKey("");
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-semibold text-foreground">
          {t("pilotDeckConfig.panels.router.tiers.title")}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {t("pilotDeckConfig.panels.router.tiers.description")}
        </div>
      </div>
      {entries.map(([key, tier]) => (
        <div
          key={key}
          className="space-y-2 rounded-lg border border-border bg-background/50 p-3"
        >
          <div className="flex items-center gap-2">
            <code className="shrink-0 rounded bg-muted px-2 py-1 text-xs font-semibold text-foreground">
              {key}
            </code>
            <div className="min-w-0 flex-1">
              <ModelRefInput
                value={tier.model ?? ""}
                options={modelOpts}
                onChange={(v) => setTier(key, "model", v)}
              />
            </div>
            <button
              type="button"
              onClick={() => removeTier(key)}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={t("pilotDeckConfig.actions.remove")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <TextAreaInput
            value={tier.description ?? ""}
            onChange={(next) => setTier(key, "description", next)}
            placeholder={t("pilotDeckConfig.panels.router.tiers.placeholder")}
          />
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="tier name (e.g. simple, medium, complex)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeEnterEvent(e)) addTier();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={addTier}
            disabled={!newKey.trim()}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("pilotDeckConfig.panels.router.tiers.add")}
          </Button>
        </div>
      </div>
    </div>
  );
}
