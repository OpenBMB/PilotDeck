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
  onChange: (next: PilotDeckConfig) => void | Promise<void>;
};

export default function ModelsSection({ config, onChange }: ModelsSectionProps) {
  const { t } = useTranslation("settings");
  const providers = config.model?.providers ?? {};
  const ids = Object.keys(providers);

  const setProvider = async (id: string, prov: V2Provider) =>
    Promise.resolve(onChange(patch(config, ["model", "providers", id], prov)));

  const removeProvider = async (id: string) => {
    const next = { ...providers };
    delete next[id];
    await Promise.resolve(onChange(patch(config, ["model", "providers"], next)));
  };

  const buildRenamedConfig = (oldId: string, newId: string) => {
    const id = newId.trim();
    if (!id || id === oldId) return { ok: true as const, config };
    if (providers[id]) return { ok: false as const };
    const next: Record<string, V2Provider> = {};
    for (const [k, v] of Object.entries(providers)) {
      next[k === oldId ? id : k] = v;
    }
    return {
      ok: true as const,
      config: rewriteProviderRefs(patch(config, ["model", "providers"], next), oldId, id),
    };
  };

  const saveProvider = async (
    oldId: string,
    newId: string,
    provider: V2Provider,
  ): Promise<{ ok: boolean; error?: string }> => {
    const trimmed = newId.trim();
    const renamed = buildRenamedConfig(oldId, trimmed);
    if (!renamed.ok) {
      return { ok: false, error: t("pilotDeckConfig.panels.models.providerIdDuplicate") };
    }
    const targetId = trimmed || oldId;
    const nextConfig = patch(renamed.config, ["model", "providers", targetId], provider);
    await Promise.resolve(onChange(nextConfig));
    return { ok: true };
  };

  const handleCatalogPick = async (cp: CatalogProvider) => {
    if (providers[cp.id]) return;
    await setProvider(cp.id, {
      apiKey: "",
      protocol: cp.protocol,
      url: cp.defaultUrl,
      models: {},
    });
  };

  const handleCustom = async () => {
    let i = 1;
    while (providers[`provider${i}`]) i++;
    await setProvider(`provider${i}`, {
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
          onSave={(nextId, nextProvider) => saveProvider(id, nextId, nextProvider)}
          onRemove={() => void removeProvider(id)}
        />
      ))}
    </div>
  );
}
