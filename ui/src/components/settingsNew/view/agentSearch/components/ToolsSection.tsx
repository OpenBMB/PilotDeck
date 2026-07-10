import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { authenticatedFetch } from "../../../../../utils/api";
import { SettingsCard, SettingsSection } from "../../../shared/view";
import { FormRow, SecretTextInput, Select, TextInput } from "../../modelPool/components/Inputs";
import type { PilotDeckConfig } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";
import {
  hasUsableSecret,
  isMaskedSecret,
} from "../../modelPool/utils/providerRefs";

type ToolsSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

type WebSearchProvider = "glm" | "tavily" | "custom";
type CustomProviderAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
type CustomProviderMethod = "GET" | "POST";
type TestStatus = "idle" | "testing" | "success" | "error";
type WebSearchConfig = NonNullable<NonNullable<PilotDeckConfig["tools"]>["webSearch"]>;
type CustomProviderConfig = NonNullable<WebSearchConfig["customProvider"]>;

export default function ToolsSection({ config, onChange }: ToolsSectionProps) {
  const { t } = useTranslation("settings");
  const glmDefaultEndpoint = "https://api.z.ai/api/paas/v4/web_search";
  const ws = config.tools?.webSearch ?? {};
  const provider: WebSearchProvider =
    ws.provider === "tavily" || ws.provider === "custom" ? ws.provider : "glm";
  const apiKey = typeof ws.apiKey === "string" ? ws.apiKey : "";
  const endpoint = typeof ws.endpoint === "string" ? ws.endpoint : "";
  const custom = ws.customProvider ?? {};
  const endpointValue = endpoint || (provider === "glm" ? glmDefaultEndpoint : "");
  const endpointPlaceholder =
    provider === "custom"
      ? "https://example.com/search"
      : provider === "tavily"
        ? "https://api.tavily.com/search"
        : glmDefaultEndpoint;

  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState("");

  const resetTest = () => {
    setTestStatus("idle");
    setTestMessage("");
  };

  const setProvider = (nextProvider: WebSearchProvider) => {
    const nextTools = {
      webSearch: {
        provider: nextProvider,
        ...(nextProvider === "glm" ? { endpoint: glmDefaultEndpoint } : {}),
      },
    };
    onChange(patch(config, ["tools"], nextTools));
    resetTest();
  };

  const setField = (field: "apiKey" | "endpoint", value: string) => {
    const trimmed = value;
    const nextWs: WebSearchConfig = { ...ws };
    nextWs.provider = provider;
    if (trimmed === "") {
      delete nextWs[field];
    } else {
      nextWs[field] = trimmed;
    }
    const nextTools = Object.keys(nextWs).length > 0 ? { webSearch: nextWs } : undefined;
    onChange(patch(config, ["tools"], nextTools));
    resetTest();
  };

  const setCustomField = (
    field: keyof CustomProviderConfig,
    value: string,
  ) => {
    const nextWs: WebSearchConfig = {
      ...ws,
      provider: "custom",
      customProvider: { ...(ws.customProvider ?? {}) } as CustomProviderConfig,
    };
    if (value === "") {
      delete nextWs.customProvider?.[field];
    } else if (field === "auth") {
      nextWs.customProvider![field] = value as CustomProviderAuth;
    } else if (field === "method") {
      nextWs.customProvider![field] = value as CustomProviderMethod;
    } else {
      nextWs.customProvider![field] = value;
    }
    if (Object.keys(nextWs.customProvider ?? {}).length === 0) {
      delete nextWs.customProvider;
    }
    onChange(patch(config, ["tools"], { webSearch: nextWs }));
    resetTest();
  };

  const handleTest = async () => {
    const trimmedKey = hasUsableSecret(apiKey) ? apiKey.trim() : "";
    if (!trimmedKey) {
      setTestStatus("error");
      setTestMessage(t("pilotDeckConfig.panels.tools.test.needsKey"));
      return;
    }
    setTestStatus("testing");
    setTestMessage("");
    try {
      const res = await authenticatedFetch("/api/config/test-web-search", {
        method: "POST",
        body: JSON.stringify({
          provider,
          apiKey: trimmedKey,
          endpoint: endpointValue.trim(),
          customProvider: custom,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus("success");
        setTestMessage(
          t("pilotDeckConfig.panels.tools.test.success", {
            count: data.organicCount ?? 0,
            latency: data.latencyMs ?? 0,
          }),
        );
      } else {
        setTestStatus("error");
        setTestMessage(
          t("pilotDeckConfig.panels.tools.test.failedPrefix", {
            error: data.error || "unknown",
          }),
        );
      }
    } catch (err) {
      setTestStatus("error");
      setTestMessage(
        t("pilotDeckConfig.panels.tools.test.failedPrefix", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <SettingsSection>
      <p className="text-sm text-muted-foreground">
        {t("pilotDeckConfig.panels.tools.description")}
      </p>
      <SettingsCard divided>
        <FormRow
          label={t("pilotDeckConfig.panels.tools.provider.label")}
          description={t("pilotDeckConfig.panels.tools.provider.description")}
        >
          <Select
            value={provider}
            options={[
              { value: "glm", label: t("pilotDeckConfig.panels.tools.provider.glm") },
              { value: "tavily", label: t("pilotDeckConfig.panels.tools.provider.tavily") },
              { value: "custom", label: t("pilotDeckConfig.panels.tools.provider.custom") },
            ]}
            onChange={(value) =>
              setProvider(
                value === "custom" ? "custom" : value === "tavily" ? "tavily" : "glm",
              )
            }
          />
        </FormRow>
        <FormRow
          label={t("pilotDeckConfig.panels.tools.apiKey.label")}
          description={t("pilotDeckConfig.panels.tools.apiKey.description")}
        >
          <SecretTextInput
            value={apiKey}
            emptyPlaceholder={t("pilotDeckConfig.panels.tools.apiKey.placeholder")}
            maskedPlaceholder={t("pilotDeckConfig.panels.tools.apiKey.maskedPlaceholder")}
            monospace
            onChange={(value) => setField("apiKey", value)}
          />
          {isMaskedSecret(apiKey) && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3" />
              {t("pilotDeckConfig.panels.tools.apiKey.keyHidden")}
            </p>
          )}
        </FormRow>
        <FormRow
          label={t("pilotDeckConfig.panels.tools.endpoint.label")}
          description={t("pilotDeckConfig.panels.tools.endpoint.description")}
        >
          <TextInput
            value={endpointValue}
            placeholder={endpointPlaceholder}
            monospace
            onChange={(value) => setField("endpoint", value)}
          />
        </FormRow>

        {provider === "custom" && (
          <>
            <FormRow
              label={t("pilotDeckConfig.panels.tools.custom.name.label")}
              description={t("pilotDeckConfig.panels.tools.custom.name.description")}
            >
              <TextInput
                value={custom.name ?? ""}
                placeholder="My Search"
                onChange={(value) => setCustomField("name", value)}
              />
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.tools.custom.auth.label")}
              description={t("pilotDeckConfig.panels.tools.custom.auth.description")}
            >
              <Select
                value={custom.auth ?? "bearer"}
                options={[
                  { value: "bearer", label: t("pilotDeckConfig.panels.tools.custom.auth.bearer") },
                  {
                    value: "bodyApiKey",
                    label: t("pilotDeckConfig.panels.tools.custom.auth.bodyApiKey"),
                  },
                  {
                    value: "queryApiKey",
                    label: t("pilotDeckConfig.panels.tools.custom.auth.queryApiKey"),
                  },
                  { value: "none", label: t("pilotDeckConfig.panels.tools.custom.auth.none") },
                ]}
                onChange={(value) => setCustomField("auth", value)}
              />
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.tools.custom.method.label")}
              description={t("pilotDeckConfig.panels.tools.custom.method.description")}
            >
              <Select
                value={custom.method ?? "POST"}
                options={[
                  { value: "POST", label: "POST" },
                  { value: "GET", label: "GET" },
                ]}
                onChange={(value) => setCustomField("method", value)}
              />
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.tools.custom.params.label")}
              description={t("pilotDeckConfig.panels.tools.custom.params.description")}
            >
              <div className="grid gap-2 md:grid-cols-2">
                <TextInput
                  value={custom.queryParam ?? ""}
                  placeholder="query"
                  monospace
                  onChange={(value) => setCustomField("queryParam", value)}
                />
                <TextInput
                  value={custom.apiKeyParam ?? ""}
                  placeholder="api_key"
                  monospace
                  onChange={(value) => setCustomField("apiKeyParam", value)}
                />
              </div>
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.tools.custom.mapping.label")}
              description={t("pilotDeckConfig.panels.tools.custom.mapping.description")}
            >
              <div className="grid gap-2 md:grid-cols-2">
                <TextInput
                  value={custom.resultsPath ?? ""}
                  placeholder="data.items"
                  monospace
                  onChange={(value) => setCustomField("resultsPath", value)}
                />
                <TextInput
                  value={custom.titleField ?? ""}
                  placeholder="title"
                  monospace
                  onChange={(value) => setCustomField("titleField", value)}
                />
                <TextInput
                  value={custom.urlField ?? ""}
                  placeholder="url"
                  monospace
                  onChange={(value) => setCustomField("urlField", value)}
                />
                <TextInput
                  value={custom.snippetField ?? ""}
                  placeholder="snippet"
                  monospace
                  onChange={(value) => setCustomField("snippetField", value)}
                />
                <TextInput
                  value={custom.sourceField ?? ""}
                  placeholder="source"
                  monospace
                  onChange={(value) => setCustomField("sourceField", value)}
                />
                <TextInput
                  value={custom.publishedAtField ?? ""}
                  placeholder="publishedAt"
                  monospace
                  onChange={(value) => setCustomField("publishedAtField", value)}
                />
              </div>
            </FormRow>
          </>
        )}

        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testStatus === "testing" || !hasUsableSecret(apiKey)}
            >
              {testStatus === "testing" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {testStatus === "testing"
                ? t("pilotDeckConfig.panels.tools.test.testing")
                : t("pilotDeckConfig.panels.tools.test.button")}
            </Button>
            {testStatus === "success" && (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
            {testStatus === "error" && (
              <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
