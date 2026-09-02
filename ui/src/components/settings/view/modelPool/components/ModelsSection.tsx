import { useEffect, useMemo, useState } from "react";
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
  providerDisplayName,
  rewriteProviderRefs,
} from "../utils/providerRefs";
import {
  countEnabledModels,
  isProviderPending,
} from "../utils/providerStatus";
import CatalogPicker from "./CatalogPicker";
import { PlusIcon, SearchIcon } from "./icons";
import ProviderAvatar from "./ProviderAvatar";
import ProviderCard from "./ProviderCard";

type ModelsSectionProps = {
  config: PilotDeckConfig;
  onChange: (
    next: PilotDeckConfig,
    options?: ConfigSaveOptions,
  ) => void | ConfigSaveResult | Promise<void | ConfigSaveResult>;
};

type PendingProvider = {
  id: string;
  provider: V2Provider;
};

export default function ModelsSection({ config, onChange }: ModelsSectionProps) {
  const { t } = useTranslation("settings");
  const providers = useMemo(
    () => config.model?.providers ?? {},
    [config.model?.providers],
  );
  const ids = useMemo(() => Object.keys(providers), [providers]);
  const [selectedId, setSelectedId] = useState(ids[0] ?? "");
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPending, setSelectedPending] = useState<boolean | null>(null);
  const [pendingProvider, setPendingProvider] = useState<PendingProvider | null>(null);
  const allIds = useMemo(
    () => pendingProvider && !ids.includes(pendingProvider.id)
      ? [...ids, pendingProvider.id]
      : ids,
    [ids, pendingProvider],
  );

  useEffect(() => {
    if (
      selectedId
      && (ids.includes(selectedId) || pendingProvider?.id === selectedId)
    ) return;
    setSelectedId(pendingProvider?.id ?? ids[0] ?? "");
  }, [ids, pendingProvider?.id, selectedId]);

  useEffect(() => {
    setSelectedPending(null);
  }, [selectedId]);

  const applyChange = async (
    next: PilotDeckConfig,
    options?: ConfigSaveOptions,
  ): Promise<ConfigSaveResult> =>
    (await onChange(next, options)) ?? { ok: true };

  const removeProvider = async (id: string) => {
    const next = { ...providers };
    delete next[id];
    await applyChange(patch(config, ["model", "providers"], next));
  };

  const bindConnectionTest = async (testId: string): Promise<ConfigSaveResult> =>
    applyChange(config, { modelTestBindings: [{ testId }] });

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
    const result = await applyChange(
      nextConfig,
      targetId !== oldId
        ? { providerRenames: [{ from: oldId, to: targetId }] }
        : undefined,
    );
    if (result.ok && targetId !== oldId) {
      setSelectedId(targetId);
    }
    return result;
  };

  const savePendingProvider = async (
    newId: string,
    provider: V2Provider,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!pendingProvider) return { ok: false };
    const targetId = newId.trim() || pendingProvider.id;
    if (providers[targetId]) {
      return { ok: false, error: t("pilotDeckConfig.panels.models.providerIdDuplicate") };
    }
    const result = await applyChange(
      patch(config, ["model", "providers", targetId], provider),
    );
    if (result.ok) {
      setPendingProvider(null);
      setSelectedId(targetId);
    }
    return result;
  };

  const discardPendingProvider = () => {
    setPendingProvider(null);
    setSelectedId(ids[0] ?? "");
  };

  const handleCatalogPick = (cp: CatalogProvider) => {
    if (providers[cp.id]) return;
    setPendingProvider({
      id: cp.id,
      provider: {
        apiKey: "",
        protocol: cp.protocol,
        url: cp.defaultUrl,
        models: {},
      },
    });
    setSelectedId(cp.id);
  };

  const handleCustom = () => {
    let i = 1;
    while (providers[`provider${i}`] || pendingProvider?.id === `provider${i}`) i++;
    const id = `provider${i}`;
    setPendingProvider({
      id,
      provider: {
        protocol: "openai",
        url: "",
        apiKey: "",
        models: {},
      },
    });
    setSelectedId(id);
  };

  const filteredIds = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allIds;
    return allIds.filter((id) => {
      const catalog = findCatalogProviderById(id);
      const name = providerDisplayName(
        id,
        catalog,
        t("pilotDeckConfig.panels.models.customProvider"),
      );
      return name.toLowerCase().includes(query) || id.toLowerCase().includes(query);
    });
  }, [allIds, search, t]);

  const selectedIsPending = pendingProvider?.id === selectedId;
  const selectedProvider = selectedIsPending
    ? pendingProvider.provider
    : selectedId
      ? providers[selectedId]
      : undefined;
  const selectedCatalog = selectedId ? findCatalogProviderById(selectedId) : undefined;

  return (
    <div className="model-pool-workspace">
      <aside className="provider-rail" aria-label={t("pilotDeckConfig.panels.models.providersKicker")}>
        <header className="provider-rail-header">
          <div>
            <span className="section-kicker">{t("pilotDeckConfig.panels.models.providersKicker")}</span>
            <strong>{t("pilotDeckConfig.panels.models.connectionCount", { count: allIds.length })}</strong>
          </div>
          <button
            className="add-provider-rail-button"
            type="button"
            aria-label={t("pilotDeckConfig.panels.models.addProvider")}
            onClick={() => setPickerOpen(true)}
          >
            <PlusIcon size={17} />
            {t("pilotDeckConfig.panels.models.addProviderShort")}
          </button>
        </header>
        <label className="provider-search">
          <SearchIcon />
          <input
            placeholder={t("pilotDeckConfig.panels.models.searchProviders")}
            aria-label={t("pilotDeckConfig.panels.models.searchProviders")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="provider-list">
          {allIds.length === 0 && (
            <p className="provider-empty">{t("pilotDeckConfig.panels.models.emptyProviders")}</p>
          )}
          {allIds.length > 0 && filteredIds.length === 0 && (
            <p className="provider-empty">{t("pilotDeckConfig.panels.models.noMatchingProviders")}</p>
          )}
          {filteredIds.map((id) => {
            const isDraft = pendingProvider?.id === id;
            const provider = isDraft ? pendingProvider.provider : (providers[id] ?? {});
            const catalog = findCatalogProviderById(id);
            const pending = id === selectedId && selectedPending !== null
              ? selectedPending
              : isDraft || isProviderPending(provider);
            const name = providerDisplayName(
              id,
              catalog,
              t("pilotDeckConfig.panels.models.customProvider"),
            );
            return (
              <button
                key={id}
                type="button"
                className={`provider-row${id === selectedId ? " selected" : ""}`}
                onClick={() => setSelectedId(id)}
              >
                <ProviderAvatar providerId={id} catalogEntry={catalog} />
                <span className="provider-row-copy">
                  <strong>{name}</strong>
                  <small>
                    {t("pilotDeckConfig.panels.models.modelCountShort", {
                      count: countEnabledModels(provider),
                    })}
                  </small>
                </span>
                {pending ? (
                  <span
                    className="connection-dot pending"
                    title={t("pilotDeckConfig.panels.models.pending")}
                    aria-label={t("pilotDeckConfig.panels.models.pending")}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </aside>

      {selectedId && selectedProvider ? (
        <ProviderCard
          key={`${selectedId}:${selectedIsPending ? "new" : "saved"}`}
          providerId={selectedId}
          provider={selectedProvider}
          isNew={selectedIsPending}
          catalogEntry={selectedCatalog}
          onSave={(nextId, nextProvider) => (
            selectedIsPending
              ? savePendingProvider(nextId, nextProvider)
              : saveProvider(selectedId, nextId, nextProvider)
          )}
          onRemove={() => {
            if (selectedIsPending) discardPendingProvider();
            else void removeProvider(selectedId);
          }}
          onCancelNew={discardPendingProvider}
          onPendingChange={setSelectedPending}
          onBindConnectionTest={bindConnectionTest}
        />
      ) : (
        <section className="provider-detail empty" aria-label={t("pilotDeckConfig.panels.models.title")}>
          <p>{t("pilotDeckConfig.panels.models.emptyProviders")}</p>
        </section>
      )}

      <CatalogPicker
        open={pickerOpen}
        existingIds={new Set(allIds)}
        onPick={handleCatalogPick}
        onCustom={handleCustom}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
