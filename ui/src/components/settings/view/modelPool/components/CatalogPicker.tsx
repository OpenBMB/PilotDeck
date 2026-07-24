import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import {
  CATALOG_PROVIDERS,
  type CatalogProvider,
} from "../../../../../shared/catalogProviders";

type CatalogPickerProps = {
  existingIds: Set<string>;
  onPick: (catalog: CatalogProvider) => void;
  onCustom: () => void;
};

export default function CatalogPicker({
  existingIds,
  onPick,
  onCustom,
}: CatalogPickerProps) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const available = CATALOG_PROVIDERS.filter((p) => !existingIds.has(p.id));

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("pilotDeckConfig.panels.models.addProvider")}
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">
          {t("pilotDeckConfig.panels.models.addProviderTitle")}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("pilotDeckConfig.panels.models.cancel")}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {available.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              onPick(p);
              setOpen(false);
            }}
            className="rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-foreground/40 hover:bg-muted"
          >
            <div className="font-medium text-foreground">{p.displayName}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {t("pilotDeckConfig.panels.models.modelCount", { count: p.models.length })}
            </div>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            onCustom();
            setOpen(false);
          }}
          className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-foreground/40 hover:bg-muted"
        >
          <div className="font-medium text-foreground">
            + {t("pilotDeckConfig.panels.models.customProvider")}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {t("pilotDeckConfig.panels.models.manualSetup")}
          </div>
        </button>
      </div>
    </div>
  );
}
