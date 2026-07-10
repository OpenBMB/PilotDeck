import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Image as ImageIcon,
  Info,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { cn } from "../../../../../lib/utils";
import type {
  CatalogModel,
  CatalogProvider,
  CatalogProviderProtocol,
} from "../../../../../shared/catalogProviders";
import {
  fetchProviderModels,
  type ApiModelListItem,
} from "../../../../../shared/modelListApi";
import type { V2Provider } from "../types";
import { isMaskedSecret, providerDisplayName } from "../utils/providerRefs";
import { FormRow, NumberInput, SecretTextInput, Select, TextInput } from "./Inputs";

type ProviderCardProps = {
  providerId: string;
  provider: V2Provider;
  onChange: (next: V2Provider) => void;
  onRemove: () => void;
  onRename: (newId: string) => boolean;
  catalogEntry?: CatalogProvider;
};

export default function ProviderCard({
  providerId,
  provider,
  onChange,
  onRemove,
  onRename,
  catalogEntry,
}: ProviderCardProps) {
  const { t } = useTranslation("settings");
  const isMaskedKey = isMaskedSecret(provider.apiKey);
  const protocol = provider.protocol ?? catalogEntry?.protocol ?? "openai";
  const effectiveUrl = provider.url || catalogEntry?.defaultUrl || "";
  const enabledModels = Object.keys(provider.models ?? {});
  const [newModelId, setNewModelId] = useState("");
  const [showProviderAdvanced, setShowProviderAdvanced] = useState(false);
  const [providerIdDraft, setProviderIdDraft] = useState(providerId);
  const [providerIdError, setProviderIdError] = useState("");
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [apiModelsStatus, setApiModelsStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [apiModelsError, setApiModelsError] = useState("");
  const displayName = providerDisplayName(
    providerIdDraft || providerId,
    catalogEntry,
    t("pilotDeckConfig.panels.models.customProvider"),
  );

  const update = (patchValue: Partial<V2Provider>) =>
    onChange({ ...provider, ...patchValue });

  const commitProviderId = () => {
    const nextId = providerIdDraft.trim();
    if (!nextId || nextId === providerId) {
      setProviderIdDraft(providerId);
      setProviderIdError("");
      return;
    }
    if (onRename(nextId)) {
      setProviderIdError("");
    } else {
      setProviderIdDraft(providerId);
      setProviderIdError(t("pilotDeckConfig.panels.models.providerIdDuplicate"));
    }
  };

  const addModel = (mid: string) => {
    const id = mid.trim();
    if (!id) return;
    if (provider.models && id in provider.models) return;
    update({ models: { ...(provider.models ?? {}), [id]: {} } });
    setNewModelId("");
  };

  const removeModel = (mid: string) => {
    const next = { ...(provider.models ?? {}) };
    delete next[mid];
    update({ models: next });
  };

  const toggleCatalogModel = (mid: string) => {
    if (provider.models && mid in provider.models) {
      removeModel(mid);
    } else {
      addModel(mid);
    }
  };

  const visibleModels: Array<ApiModelListItem | CatalogModel> =
    apiModels ?? catalogEntry?.models ?? [];
  const canFetchModels = Boolean(effectiveUrl && provider.apiKey);

  const refreshModels = async () => {
    if (!canFetchModels) return;
    setApiModelsStatus("loading");
    setApiModelsError("");
    try {
      const models = await fetchProviderModels({
        protocol,
        baseUrl: effectiveUrl,
        apiKey: provider.apiKey ?? "",
        providerId,
      });
      setApiModels(models);
      setApiModelsStatus("idle");
    } catch (error) {
      setApiModelsStatus("error");
      setApiModelsError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4 transition-colors">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-foreground">
              {displayName}
            </div>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t("pilotDeckConfig.panels.models.providerId")}
            </span>
            <input
              value={providerIdDraft}
              onChange={(e) => {
                setProviderIdDraft(e.target.value);
                setProviderIdError("");
              }}
              onBlur={commitProviderId}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setProviderIdDraft(providerId);
                  setProviderIdError("");
                  e.currentTarget.blur();
                }
              }}
              className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {providerIdError && (
            <div className="mt-1 text-[10px] text-destructive">
              {providerIdError}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">
            {t("pilotDeckConfig.panels.models.protocol")}
          </span>
          <Select
            value={protocol}
            onChange={(v) => update({ protocol: v as CatalogProviderProtocol })}
            options={[
              {
                value: "openai",
                label: t("pilotDeckConfig.panels.models.protocolOptions.openai"),
              },
              {
                value: "openai-responses",
                label: t(
                  "pilotDeckConfig.panels.models.protocolOptions.openaiResponses",
                ),
              },
              {
                value: "anthropic",
                label: t(
                  "pilotDeckConfig.panels.models.protocolOptions.anthropic",
                ),
              },
              {
                value: "google",
                label: t("pilotDeckConfig.panels.models.protocolOptions.google"),
              },
            ]}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">
            {t("pilotDeckConfig.panels.models.baseUrl")}
          </span>
          <TextInput
            value={provider.url}
            placeholder={catalogEntry?.defaultUrl || "https://api.example.com/v1"}
            monospace
            onChange={(v) => update({ url: v })}
          />
          <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
            {t("pilotDeckConfig.panels.models.baseUrlHint")}
          </span>
          {!provider.url && catalogEntry && (
            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
              {t("pilotDeckConfig.panels.models.defaultsTo")}{" "}
              <code className="font-mono">{catalogEntry.defaultUrl}</code>{" "}
              {t("pilotDeckConfig.panels.models.fromCatalog")}
            </span>
          )}
          {effectiveUrl && provider.url && (
            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
              {t("pilotDeckConfig.panels.models.effective")}{" "}
              <code className="font-mono">{effectiveUrl}</code>
            </span>
          )}
        </label>
      </div>

      <label className="block text-xs text-muted-foreground">
        <span className="mb-1 block">
          {t("pilotDeckConfig.panels.models.apiKey")}
        </span>
        <SecretTextInput
          value={provider.apiKey}
          emptyPlaceholder="sk-..."
          maskedPlaceholder={t("pilotDeckConfig.panels.models.maskedKeyPlaceholder")}
          onChange={(v) => update({ apiKey: v })}
        />
        {isMaskedKey && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3" />
            {t("pilotDeckConfig.panels.models.keyHidden")}
          </span>
        )}
      </label>

      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>{t("pilotDeckConfig.panels.models.enabledModels")}</span>
          <span className="text-[10px] text-muted-foreground/60">
            · <ImageIcon className="inline h-2.5 w-2.5" />{" "}
            {t("pilotDeckConfig.panels.models.supportsImageInput")}
          </span>
          <button
            type="button"
            onClick={refreshModels}
            disabled={!canFetchModels || apiModelsStatus === "loading"}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw
              className={cn(
                "h-2.5 w-2.5",
                apiModelsStatus === "loading" && "animate-spin",
              )}
            />
            Fetch API models
          </button>
        </div>

        {apiModelsStatus === "error" && apiModelsError && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
            {apiModelsError}
          </div>
        )}

        {visibleModels.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {visibleModels.map((m) => {
              const on = provider.models && m.id in provider.models;
              return (
                <div
                  key={m.id}
                  className={cn(
                    "group inline-flex items-center rounded-md border text-[11px] transition-colors",
                    on
                      ? "border-foreground/30 bg-muted/60 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleCatalogModel(m.id)}
                    className="inline-flex items-center gap-1 px-2 py-1"
                    title={
                      on
                        ? t("pilotDeckConfig.panels.models.clickDisable")
                        : t("pilotDeckConfig.panels.models.clickEnable")
                    }
                  >
                    {on && (
                      <Check className="h-3 w-3 text-foreground" strokeWidth={2.5} />
                    )}
                    {m.displayName}
                    {"supportsImage" in m && m.supportsImage && (
                      <ImageIcon
                        className="h-3 w-3 text-muted-foreground/70"
                        strokeWidth={2}
                      />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {enabledModels
          .filter((mid) => !visibleModels.some((m) => m.id === mid))
          .map((mid) => (
            <div
              key={mid}
              className="mb-1 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]"
            >
              <code className="flex-1 truncate font-mono">{mid}</code>
              <button
                type="button"
                onClick={() => removeModel(mid)}
                className="text-muted-foreground hover:text-destructive"
                title={t("pilotDeckConfig.actions.remove")}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}

        <div className="flex items-center gap-2">
          <input
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder={t("pilotDeckConfig.panels.models.customModelPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeEnterEvent(e)) addModel(newModelId);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => addModel(newModelId)}
            disabled={!newModelId.trim()}
          >
            <Plus className="mr-1 h-3 w-3" />
            {t("pilotDeckConfig.actions.add")}
          </Button>
        </div>
      </div>

      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={() => setShowProviderAdvanced((v) => !v)}
          aria-expanded={showProviderAdvanced}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              showProviderAdvanced && "rotate-180",
            )}
          />
          {t("pilotDeckConfig.panels.models.providerAdvancedToggle")}
        </button>
        {showProviderAdvanced && (
          <div className="mt-3 space-y-3 divide-y divide-border rounded-md border border-border p-3">
            <FormRow
              label={t(
                "pilotDeckConfig.panels.models.providerRetry.requestMaxRetries.label",
              )}
              description={t(
                "pilotDeckConfig.panels.models.providerRetry.requestMaxRetries.description",
              )}
            >
              <NumberInput
                value={provider.retry?.requestMaxRetries}
                placeholder="2"
                onChange={(v) =>
                  onChange({
                    ...provider,
                    retry: { ...provider.retry, requestMaxRetries: v },
                  })
                }
              />
            </FormRow>
            <FormRow
              label={t(
                "pilotDeckConfig.panels.models.providerRetry.streamMaxRetries.label",
              )}
              description={t(
                "pilotDeckConfig.panels.models.providerRetry.streamMaxRetries.description",
              )}
            >
              <NumberInput
                value={provider.retry?.streamMaxRetries}
                placeholder="3"
                onChange={(v) =>
                  onChange({
                    ...provider,
                    retry: { ...provider.retry, streamMaxRetries: v },
                  })
                }
              />
            </FormRow>
            <FormRow
              label={t(
                "pilotDeckConfig.panels.models.providerRetry.streamIdleTimeoutMs.label",
              )}
              description={t(
                "pilotDeckConfig.panels.models.providerRetry.streamIdleTimeoutMs.description",
              )}
            >
              <NumberInput
                value={provider.retry?.streamIdleTimeoutMs}
                placeholder="30000"
                onChange={(v) =>
                  onChange({
                    ...provider,
                    retry: { ...provider.retry, streamIdleTimeoutMs: v },
                  })
                }
              />
            </FormRow>
            <FormRow
              label={t(
                "pilotDeckConfig.panels.models.providerRetry.baseDelayMs.label",
              )}
              description={t(
                "pilotDeckConfig.panels.models.providerRetry.baseDelayMs.description",
              )}
            >
              <NumberInput
                value={provider.retry?.baseDelayMs}
                placeholder="1000"
                onChange={(v) =>
                  onChange({
                    ...provider,
                    retry: { ...provider.retry, baseDelayMs: v },
                  })
                }
              />
            </FormRow>
            <FormRow
              label={t(
                "pilotDeckConfig.panels.models.providerRetry.maxDelayMs.label",
              )}
              description={t(
                "pilotDeckConfig.panels.models.providerRetry.maxDelayMs.description",
              )}
            >
              <NumberInput
                value={provider.retry?.maxDelayMs}
                placeholder="60000"
                onChange={(v) =>
                  onChange({
                    ...provider,
                    retry: { ...provider.retry, maxDelayMs: v },
                  })
                }
              />
            </FormRow>
          </div>
        )}
      </div>
    </div>
  );
}
