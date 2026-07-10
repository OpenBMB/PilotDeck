import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

type TokenSaverRulesEditorProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function TokenSaverRulesEditor({
  config,
  onChange,
}: TokenSaverRulesEditorProps) {
  const { t } = useTranslation("settings");
  const rules = config.router?.tokenSaver?.rules ?? [];
  const [newRule, setNewRule] = useState("");

  const setRule = (idx: number, value: string) => {
    const next = [...rules];
    next[idx] = value;
    onChange(patch(config, ["router", "tokenSaver", "rules"], next));
  };
  const removeRule = (idx: number) =>
    onChange(
      patch(
        config,
        ["router", "tokenSaver", "rules"],
        rules.filter((_, i) => i !== idx),
      ),
    );

  const addRule = () => {
    const r = newRule.trim();
    if (!r) return;
    onChange(patch(config, ["router", "tokenSaver", "rules"], [...rules, r]));
    setNewRule("");
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-foreground">
        {t("pilotDeckConfig.panels.router.rules.title")}
      </div>
      {rules.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.router.rules.empty")}
        </div>
      )}
      {rules.map((rule, idx) => (
        <div key={idx} className="flex items-start gap-2">
          <textarea
            value={rule}
            onChange={(e) => setRule(idx, e.target.value)}
            rows={2}
            className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => removeRule(idx)}
            className="mt-1 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t("pilotDeckConfig.actions.remove")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          placeholder={t("pilotDeckConfig.panels.router.rules.placeholder")}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeEnterEvent(e)) addRule();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={addRule}
          disabled={!newRule.trim()}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("pilotDeckConfig.panels.router.rules.add")}
        </Button>
      </div>
    </div>
  );
}
