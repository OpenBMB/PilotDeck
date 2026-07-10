import { useTranslation } from "react-i18next";
import {
  findCatalogProviderById,
  type CatalogProvider,
} from "../../../../../shared/catalogProviders";
import { patch } from "../utils/patch";
import type { PilotDeckConfig, V2Provider } from "../types";
import { rewriteProviderRefs } from "../utils/providerRefs";
import { PageSectionHeader } from "../../../shared/view";
import CatalogPicker from "./CatalogPicker";
import ProviderCard from "./ProviderCard";

type ModelsSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function ModelsSection({ config, onChange }: ModelsSectionProps) {
  const { t } = useTranslation("settings");
  const providers = config.model?.providers ?? {};
  const ids = Object.keys(providers);

  const setProvider = (id: string, prov: V2Provider) =>
    onChange(patch(config, ["model", "providers", id], prov));

  const removeProvider = (id: string) => {
    const next = { ...providers };
    delete next[id];
    onChange(patch(config, ["model", "providers"], next));
  };

  const renameProvider = (oldId: string, newId: string) => {
    const id = newId.trim();
    if (!id || id === oldId) return true;
    if (providers[id]) return false;
    const next: Record<string, V2Provider> = {};
    for (const [k, v] of Object.entries(providers)) {
      next[k === oldId ? id : k] = v;
    }
    onChange(
      rewriteProviderRefs(patch(config, ["model", "providers"], next), oldId, id),
    );
    return true;
  };

  const handleCatalogPick = (cp: CatalogProvider) => {
    if (providers[cp.id]) return;
    setProvider(cp.id, {
      apiKey: "",
      protocol: cp.protocol,
      url: cp.defaultUrl,
      models: {},
    });
  };

  const handleCustom = () => {
    let i = 1;
    while (providers[`provider${i}`]) i++;
    setProvider(`provider${i}`, {
      protocol: "openai",
      url: "",
      apiKey: "",
      models: {},
    });
  };

  return (
    <div className="space-y-3">
      <PageSectionHeader description={t("pilotDeckConfig.panels.models.description")} />
      <div className="flex justify-start">
        <CatalogPicker
          existingIds={new Set(ids)}
          onPick={handleCatalogPick}
          onCustom={handleCustom}
        />
      </div>
      {ids.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t("pilotDeckConfig.panels.models.emptyProviders")}
        </div>
      )}
      {ids.map((id) => (
        <ProviderCard
          key={id}
          providerId={id}
          provider={providers[id] ?? {}}
          catalogEntry={findCatalogProviderById(id)}
          onChange={(next) => setProvider(id, next)}
          onRemove={() => removeProvider(id)}
          onRename={(newId) => renameProvider(id, newId)}
        />
      ))}
    </div>
  );
}
