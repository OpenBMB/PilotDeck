import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { authenticatedFetch } from "../../../../utils/api";
import { findCatalogProviderById } from "../../../../shared/catalogProviders";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import AgentsSection from "./components/AgentsSection";
import { splitModelRef } from "./utils/modelRefs";

type AgentModelSectionsProps = {
  title: string;
};

export default function AgentModelSections({ title }: AgentModelSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const [modelTestError, setModelTestError] = useState<string | null>(null);
  const changeGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  useEffect(() => () => {
    changeGeneration.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
  }, []);

  const onFormChange = async (next: PilotDeckConfig) => {
    const generation = ++changeGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      setModelTestError(null);
      const currentRef = parsedConfig?.agent?.model;
      const nextRef = next.agent?.model;
      const parsedNext = splitModelRef(nextRef);
      const currentProvider = currentRef ? splitModelRef(currentRef) : null;
      const nextProvider = parsedNext ? next.model?.providers?.[parsedNext.providerId] : undefined;
      const nextModel = parsedNext ? nextProvider?.models?.[parsedNext.modelId] : undefined;
      const hasPassingConnectionTest = Boolean(
        nextModel
        && typeof nextModel === "object"
        && !Array.isArray(nextModel)
        && (nextModel as Record<string, unknown>).connectionTest
        && typeof (nextModel as Record<string, unknown>).connectionTest === "object"
        && ((nextModel as Record<string, unknown>).connectionTest as Record<string, unknown>).status === "passed",
      );
      const isNewReferencedModel = Boolean(
        parsedNext
        && (!currentProvider || currentRef !== nextRef)
        && !hasPassingConnectionTest
        && Object.prototype.hasOwnProperty.call(parsedConfig?.model?.providers ?? {}, parsedNext.providerId),
      );
      let modelTestBindings: Array<{ testId: string }> | undefined;
      if (isNewReferencedModel && parsedNext && nextProvider) {
        const catalog = findCatalogProviderById(parsedNext.providerId);
        const endpoint = nextProvider.url || catalog?.defaultUrl || "";
        const protocol = nextProvider.protocol || catalog?.protocol || "openai";
        const response = await authenticatedFetch("/api/config/test-connections", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            providerId: parsedNext.providerId,
            protocol,
            endpoint,
            apiKey: nextProvider.apiKey ?? "",
            models: [parsedNext.modelId],
            retryPolicy: {},
          }),
        });
        const result = await response.json();
        if (!response.ok || result.status === "failed") {
          throw new Error(result.error?.message || result.message || "Model connection test failed.");
        }
        if (result.status === "manual_input_required") {
          const unknownModels = Array.isArray(result.models)
            ? result.models.filter((model: { imageInput?: string }) => model.imageInput === "unknown")
            : [];
          const capabilities = unknownModels.map((model: { modelId: string }) => ({
            modelId: model.modelId,
            imageInput: window.confirm(`Does ${model.modelId} support image input?`) ? "supported" : "unsupported",
          }));
          const completed = await authenticatedFetch(`/api/config/test-connections/${result.testId}/image-capabilities`, {
            method: "PUT",
            signal: controller.signal,
            body: JSON.stringify({ models: capabilities }),
          });
          const completedResult = await completed.json();
          if (!completed.ok || completedResult.status !== "passed") {
            throw new Error(completedResult.error?.message || "Image capability confirmation failed.");
          }
        }
        modelTestBindings = [{ testId: result.testId }];
      }
      if (generation !== changeGeneration.current) return;
      setRaw(configToYamlString(next));
      void save(modelTestBindings ? { modelTestBindings } : undefined);
    } catch (caught) {
      if (generation !== changeGeneration.current || controller.signal.aborted) return;
      const message = caught instanceof Error ? caught.message : "Failed to save agent model config patch";
      setModelTestError(message);
      console.error("Failed to serialise agent model config patch", caught);
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.agentModel")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      {modelTestError && <ConfigSaveError error={modelTestError} />}
      <AgentsSection config={parsedConfig} onChange={onFormChange} />
    </div>
  );
}
