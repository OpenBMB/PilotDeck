import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  findCatalogProviderById,
  type CatalogProvider,
} from "../../../../../shared/catalogProviders";
import type {
  ConfigSaveOptions,
  ConfigSaveResult,
} from "../../../../../hooks/usePilotDeckConfig";
import { patch } from "../utils/patch";
import type { PilotDeckConfig, V2Provider } from "../types";
import {
  clearSubagentDefaultForRemovedModel,
  clearSubagentDefaultForRemovedProvider,
  rewriteProviderRefs,
} from "../utils/providerRefs";
import { PageSectionHeader } from "../../../shared/view";
import CatalogPicker from "./CatalogPicker";
import ProviderCard from "./ProviderCard";

type ModelsSectionProps = {
  config: PilotDeckConfig;
  onChange: (
    next: PilotDeckConfig,
    options?: ConfigSaveOptions,
  ) => void | ConfigSaveResult | Promise<void | ConfigSaveResult>;
};

export default function ModelsSection({ config, onChange }: ModelsSectionProps) {
  const { t } = useTranslation("settings");
  const providers = config.model?.providers ?? {};
  const ids = Object.keys(providers);
  const [pendingProvider, setPendingProvider] = useState<{
    id: string;
    provider: V2Provider;
    catalogEntry?: CatalogProvider;
  } | null>(null);

  const applyChange = async (
    next: PilotDeckConfig,
    options?: ConfigSaveOptions,
  ): Promise<ConfigSaveResult> =>
    (await onChange(next, options)) ?? { ok: true };

  const removeProvider = async (id: string) => {
    const next = { ...providers };
    delete next[id];
    await applyChange(
      clearSubagentDefaultForRemovedProvider(
        patch(config, ["model", "providers"], next),
        id,
      ),
    );
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
    let nextConfig = patch(renamed.config, ["model", "providers", targetId], provider);
    if (targetId === oldId) {
      const previousModels = providers[oldId]?.models ?? {};
      const nextModels = provider.models ?? {};
      for (const modelId of Object.keys(previousModels)) {
        if (!(modelId in nextModels)) {
          nextConfig = clearSubagentDefaultForRemovedModel(nextConfig, targetId, modelId);
        }
      }
    }
    return applyChange(
      nextConfig,
      targetId !== oldId
        ? { providerRenames: [{ from: oldId, to: targetId }] }
        : undefined,
    );
  };

  const savePendingProvider = async (
    newId: string,
    provider: V2Provider,
  ): Promise<{ ok: boolean; error?: string }> => {
    const id = newId.trim();
    if (providers[id]) {
      return { ok: false, error: t("pilotDeckConfig.panels.models.providerIdDuplicate") };
    }
    const result = await applyChange(
      patch(config, ["model", "providers", id], provider),
    );
    if (result.ok) setPendingProvider(null);
    return result;
  };

  const handleCatalogPick = (cp: CatalogProvider) => {
    if (providers[cp.id] || pendingProvider) return;
    setPendingProvider({
      id: cp.id,
      catalogEntry: cp,
      provider: {
        apiKey: "",
        protocol: cp.protocol,
        url: cp.defaultUrl,
        models: {},
      },
    });
  };

  const handleCustom = () => {
    if (pendingProvider) return;
    let i = 1;
    while (providers[`provider${i}`]) i++;
    setPendingProvider({
      id: `provider${i}`,
      provider: {
        protocol: "openai",
        url: "",
        apiKey: "",
        models: {},
      },
    });
  };

  const pickerIds = new Set(ids);
  if (pendingProvider) pickerIds.add(pendingProvider.id);

  return (
    <div className="space-y-3">
      <PageSectionHeader description={t("pilotDeckConfig.panels.models.description")} />
      {!pendingProvider && <div className="flex justify-start">
        <CatalogPicker
          existingIds={pickerIds}
          onPick={handleCatalogPick}
          onCustom={handleCustom}
        />
      </div>}
      {ids.length === 0 && !pendingProvider && (
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
      {pendingProvider && (
        <ProviderCard
          key={`pending-${pendingProvider.id}`}
          providerId={pendingProvider.id}
          provider={pendingProvider.provider}
          catalogEntry={pendingProvider.catalogEntry}
          initialEditing
          onCancelNew={() => setPendingProvider(null)}
          onSave={savePendingProvider}
          onRemove={() => setPendingProvider(null)}
        />
      )}
    </div>
  );
}
