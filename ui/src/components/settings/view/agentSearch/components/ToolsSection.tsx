import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../../utils/api";
import { SettingsToggle } from "../../../shared/view";
import { MASK } from "../../../shared/utils/secret";
import type { PilotDeckConfig } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";
import {
  hasUsableSecret,
  isMaskedSecret,
} from "../../modelPool/utils/providerRefs";
import {
  webSearchConfigForProvider,
  type WebSearchProvider,
} from "../utils/webSearchConfig";

type ToolsSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

type TestStatus = "idle" | "testing" | "success" | "error";
type TestErrorKind = "validation" | "connection";
type EditableSearchField = "apiKey" | "endpoint";
type WebSearchConfig = NonNullable<
  NonNullable<PilotDeckConfig["tools"]>["webSearch"]
>;

const GLM_DEFAULT_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";

const PROVIDERS: WebSearchProvider[] = [
  "glm",
  "tavily",
  "serper",
  "brave",
  "custom",
];

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path
        d="M192,112a80,80,0,1,1-80-80A80,80,0,0,1,192,112Z"
        opacity="0.2"
      />
      <path d="M229.66,218.34,179.6,168.28a88.21,88.21,0,1,0-11.32,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path
        d="M232,98.36C230.73,136.92,198.67,168,160.09,168a71.68,71.68,0,0,1-26.92-5.17h0L120,176H96v24H72v24H40a8,8,0,0,1-8-8V187.31a8,8,0,0,1,2.34-5.65l58.83-58.83h0A71.68,71.68,0,0,1,88,95.91c0-38.58,31.08-70.64,69.64-71.87A72,72,0,0,1,232,98.36Z"
        opacity="0.2"
      />
      <path d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M137.54,186.36a8,8,0,0,1,0,11.31l-5.66,5.66a56,56,0,0,1-79.2-79.2L81,95.81a56,56,0,0,1,79.2,0,8,8,0,1,1-11.31,11.31,40,40,0,0,0-56.58,0L64,135.44A40,40,0,0,0,120.57,192l5.66-5.66A8,8,0,0,1,137.54,186.36Zm65.78-133.68a56.08,56.08,0,0,0-79.2,0l-5.66,5.66a8,8,0,0,0,11.31,11.32L135.43,64A40,40,0,0,1,192,120.56l-28.28,28.28a40,40,0,0,1-56.58,0,8,8,0,0,0-11.31,11.32,56,56,0,0,0,79.2,0l28.28-28.28A56.08,56.08,0,0,0,203.32,52.68Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M222.14,69.17,186.83,33.86A19.86,19.86,0,0,0,172.69,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V83.31A19.86,19.86,0,0,0,222.14,69.17ZM164,204H92V160h72Zm40,0H188V156a20,20,0,0,0-20-20H88a20,20,0,0,0-20,20v48H52V52H171l33,33ZM164,84a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h56A12,12,0,0,1,164,84Z" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="17"
      height="17"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path
        d="M185,127,127,185a24,24,0,0,1-33.94,0L71,162.91A24,24,0,0,1,71,129L129,71a24,24,0,0,1,33.94,0L185,93.09A24,24,0,0,1,185,127Z"
        opacity="0.2"
      />
      <path d="M237.66,18.34a8,8,0,0,0-11.32,0l-52.4,52.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L100,88.69l-6.34-6.35A8,8,0,0,0,82.34,93.66L88.69,100,65.37,123.31a32,32,0,0,0,0,45.26l5.38,5.37-52.41,52.4a8,8,0,0,0,11.32,11.32l52.4-52.41,5.37,5.38a32.06,32.06,0,0,0,45.26,0L156,167.31l6.34,6.35a8,8,0,0,0,11.32-11.32L167.31,156l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,52.41-52.4A8,8,0,0,0,237.66,18.34Zm-116.29,161a16,16,0,0,1-22.62,0L76.69,157.25a16,16,0,0,1,0-22.62L100,111.31,144.69,156Zm57.94-57.94L156,144.69,111.31,100l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22a16,16,0,0,1,0,22.63Z" />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm-8,56a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm8,104a12,12,0,1,1,12-12A12,12,0,0,1,128,184Z" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="spin"
      width="17"
      height="17"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function normalizeProvider(value: unknown): WebSearchProvider {
  return PROVIDERS.includes(value as WebSearchProvider)
    ? (value as WebSearchProvider)
    : "glm";
}

export default function ToolsSection({ config, onChange }: ToolsSectionProps) {
  const { t } = useTranslation("settings");
  const ws = config.tools?.webSearch ?? {};
  const enabled = ws.enabled !== false;
  const provider = normalizeProvider(ws.provider);
  const apiKey = typeof ws.apiKey === "string" ? ws.apiKey : "";
  const endpoint = typeof ws.endpoint === "string" ? ws.endpoint : "";
  const [editingField, setEditingField] =
    useState<EditableSearchField | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testErrorKind, setTestErrorKind] =
    useState<TestErrorKind | null>(null);
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    if (editingField !== "endpoint") setEndpointDraft(endpoint);
  }, [editingField, endpoint]);

  const resetTest = () => {
    setTestStatus("idle");
    setTestErrorKind(null);
    setTestMessage("");
  };

  const updateWebSearch = (next: WebSearchConfig) => {
    onChange(patch(config, ["tools", "webSearch"], next));
    resetTest();
  };

  const setProvider = (nextProvider: WebSearchProvider) => {
    const next = webSearchConfigForProvider(
      ws,
      nextProvider,
      GLM_DEFAULT_ENDPOINT,
    );
    if (nextProvider === "custom") {
      next.customProvider = { auth: "bearer", method: "POST" };
    }
    updateWebSearch(next);
    setEditingField(null);
    setApiKeyDraft("");
  };

  const startApiKeyEdit = () => {
    setApiKeyDraft(isMaskedSecret(apiKey) ? "" : apiKey);
    setEditingField("apiKey");
  };

  const saveApiKey = () => {
    const value = apiKeyDraft.trim();
    if (!value) return;
    updateWebSearch({
      ...ws,
      provider,
      apiKey: value,
      ...(provider === "custom"
        ? {
            customProvider: {
              ...ws.customProvider,
              auth: "bearer",
              method: ws.customProvider?.method ?? "POST",
            },
          }
        : {}),
    });
    setEditingField(null);
    setApiKeyDraft("");
  };

  const saveEndpoint = () => {
    const value = endpointDraft.trim();
    if (!value) return;
    updateWebSearch({
      ...ws,
      provider: "custom",
      endpoint: value,
      customProvider: {
        ...ws.customProvider,
        auth: "bearer",
        method: ws.customProvider?.method ?? "POST",
      },
    });
    setEditingField(null);
  };

  const cancelEdit = () => {
    setApiKeyDraft("");
    setEndpointDraft(endpoint);
    setEditingField(null);
  };

  const handleTest = async () => {
    const trimmedKey = hasUsableSecret(apiKey)
      ? apiKey.trim()
      : isMaskedSecret(apiKey)
        ? MASK
        : "";
    const trimmedEndpoint = endpoint.trim();

    if (provider === "custom" && !trimmedEndpoint && !trimmedKey) {
      setTestStatus("error");
      setTestErrorKind("validation");
      setTestMessage(
        t("pilotDeckConfig.panels.tools.test.needsEndpointAndKey"),
      );
      return;
    }
    if (provider === "custom" && !trimmedEndpoint) {
      setTestStatus("error");
      setTestErrorKind("validation");
      setTestMessage(t("pilotDeckConfig.panels.tools.test.needsEndpoint"));
      return;
    }
    if (!trimmedKey) {
      setTestStatus("error");
      setTestErrorKind("validation");
      setTestMessage(t("pilotDeckConfig.panels.tools.test.needsKey"));
      return;
    }

    setTestStatus("testing");
    setTestErrorKind(null);
    setTestMessage("");
    try {
      const response = await authenticatedFetch(
        "/api/config/test-web-search",
        {
          method: "POST",
          body: JSON.stringify({
            provider,
            apiKey: trimmedKey,
            ...(provider === "custom" ? { endpoint: trimmedEndpoint } : {}),
            customProvider:
              provider === "custom"
                ? {
                    ...ws.customProvider,
                    auth: "bearer",
                    method: ws.customProvider?.method ?? "POST",
                  }
                : undefined,
          }),
        },
      );
      const data = await response.json();
      if (data.ok) {
        setTestStatus("success");
        setTestErrorKind(null);
        setTestMessage(
          t("pilotDeckConfig.panels.tools.test.success", {
            count: data.organicCount ?? 0,
            latency: data.latencyMs ?? 0,
          }),
        );
      } else {
        setTestStatus("error");
        setTestErrorKind("connection");
        setTestMessage(
          t("pilotDeckConfig.panels.tools.test.failureDetail", {
            error: data.error || "unknown",
          }),
        );
      }
    } catch (error) {
      setTestStatus("error");
      setTestErrorKind("connection");
      setTestMessage(
        t("pilotDeckConfig.panels.tools.test.failureDetail", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const renderActions = (
    field: EditableSearchField,
    canSave: boolean,
    onSave: () => void,
  ) =>
    editingField === field ? (
      <div className="search-inline-actions">
        <button
          className="button secondary compact"
          type="button"
          onClick={cancelEdit}
        >
          <CancelIcon />
          {t("settingsPage.actions.cancel")}
        </button>
        <button
          className="button primary compact"
          type="button"
          disabled={!canSave}
          onClick={onSave}
        >
          <SaveIcon />
          {t("settingsPage.actions.save")}
        </button>
      </div>
    ) : (
      <button
        className="button secondary compact search-edit-button"
        type="button"
        disabled={!enabled || editingField !== null}
        onClick={() =>
          field === "apiKey" ? startApiKeyEdit() : setEditingField("endpoint")
        }
      >
        <EditIcon />
        {t("settingsPage.actions.edit")}
      </button>
    );

  return (
    <>
      <section
        className="route-card route-enable-card search-enable-card"
        aria-label={t("pilotDeckConfig.panels.tools.enabled.aria")}
      >
        <div className="route-card-heading">
          <span className="route-heading-icon">
            <SearchIcon />
          </span>
          <div>
            <h2>{t("pilotDeckConfig.panels.tools.enabled.label")}</h2>
          </div>
        </div>
        <SettingsToggle
          checked={enabled}
          ariaLabel={t("pilotDeckConfig.panels.tools.enabled.label")}
          onChange={(value) => {
            updateWebSearch({ ...ws, enabled: value });
            setEditingField(null);
          }}
          suppressNextSaveToast
        />
      </section>

      <section
        className="search-card"
        aria-label={t("pilotDeckConfig.panels.tools.configAria")}
      >
        <div className={`search-config-body${enabled ? "" : " disabled"}`}>
          <div className="search-setting-row">
            <div className="search-setting-copy">
              <label htmlFor="search-provider">
                {t("pilotDeckConfig.panels.tools.provider.label")}
              </label>
              <p>{t("pilotDeckConfig.panels.tools.provider.description")}</p>
            </div>
            <div className="search-control-area">
              <div className="search-select-wrap">
                <select
                  id="search-provider"
                  value={provider}
                  disabled={!enabled}
                  onChange={(event) =>
                    setProvider(normalizeProvider(event.target.value))
                  }
                >
                  {PROVIDERS.map((value) => (
                    <option key={value} value={value}>
                      {t(`pilotDeckConfig.panels.tools.provider.${value}`)}
                    </option>
                  ))}
                </select>
                <ChevronIcon />
              </div>
            </div>
          </div>

          {provider === "custom" ? (
            <div className="search-setting-row">
              <div className="search-setting-copy">
                <label htmlFor="search-endpoint">
                  {t("pilotDeckConfig.panels.tools.endpoint.label")}
                </label>
                <p>{t("pilotDeckConfig.panels.tools.endpoint.description")}</p>
              </div>
              <div className="search-control-area search-editable-control">
                <div className="search-input-wrap">
                  <LinkIcon />
                  <input
                    id="search-endpoint"
                    type="url"
                    required
                    disabled={!enabled || editingField !== "endpoint"}
                    aria-invalid={
                      editingField === "endpoint" && !endpointDraft.trim()
                    }
                    value={
                      editingField === "endpoint" ? endpointDraft : endpoint
                    }
                    placeholder={t(
                      "pilotDeckConfig.panels.tools.endpoint.placeholder",
                    )}
                    onChange={(event) => setEndpointDraft(event.target.value)}
                  />
                </div>
                {renderActions(
                  "endpoint",
                  Boolean(endpointDraft.trim()),
                  saveEndpoint,
                )}
              </div>
            </div>
          ) : null}

          <div className="search-setting-row">
            <div className="search-setting-copy">
              <label htmlFor="search-api-key">
                {t("pilotDeckConfig.panels.tools.apiKey.label")}
              </label>
              <p>{t("pilotDeckConfig.panels.tools.apiKey.description")}</p>
            </div>
            <div className="search-control-area search-editable-control">
              <div className="search-input-wrap">
                <KeyIcon />
                <input
                  id="search-api-key"
                  type="password"
                  required
                  autoComplete="off"
                  disabled={!enabled || editingField !== "apiKey"}
                  aria-invalid={
                    editingField === "apiKey" && !apiKeyDraft.trim()
                  }
                  value={
                    editingField === "apiKey"
                      ? apiKeyDraft
                      : isMaskedSecret(apiKey)
                        ? MASK
                        : apiKey
                  }
                  placeholder={t(
                    "pilotDeckConfig.panels.tools.apiKey.providerPlaceholder",
                    {
                      provider: t(
                        `pilotDeckConfig.panels.tools.provider.${provider}`,
                      ),
                    },
                  )}
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                />
              </div>
              {renderActions(
                "apiKey",
                Boolean(apiKeyDraft.trim()),
                saveApiKey,
              )}
            </div>
          </div>
        </div>

        <footer className="search-test-footer">
          <div className="test-row search-test-row">
            {testStatus === "success" ? (
              <div className="test-success" role="status" aria-live="polite">
                <SuccessIcon />
                <div>
                  <strong>
                    {t("pilotDeckConfig.panels.tools.test.successTitle")}
                  </strong>
                  <p>{testMessage}</p>
                </div>
              </div>
            ) : null}
            {testStatus === "error" ? (
              <div className="test-error" role="alert" aria-live="assertive">
                <ErrorIcon />
                <div>
                  <strong>
                    {t(
                      testErrorKind === "validation"
                        ? "pilotDeckConfig.panels.tools.test.incompleteTitle"
                        : "pilotDeckConfig.panels.tools.test.failureTitle",
                    )}
                  </strong>
                  <p>{testMessage}</p>
                </div>
              </div>
            ) : null}
            <button
              className={`test-button ${testStatus}`}
              type="button"
              disabled={!enabled || testStatus === "testing"}
              onClick={() => void handleTest()}
            >
              {testStatus === "testing" ? (
                <LoadingIcon />
              ) : (
                <PlugIcon />
              )}
              {testStatus === "testing"
                ? t("pilotDeckConfig.panels.tools.test.testing")
                : t("pilotDeckConfig.panels.tools.test.button")}
            </button>
          </div>
        </footer>
      </section>
    </>
  );
}
