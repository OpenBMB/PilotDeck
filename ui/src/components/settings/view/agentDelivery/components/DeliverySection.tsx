import { useTranslation } from "react-i18next";
import { DEFAULT_DELIVERY_PROMPT } from "../../../../../../../src/agent/sub/delivery/prompt";
import { SettingsToggle } from "../../../shared/view";
import { buildModelRefOptions } from "../../agentModel/utils/modelRefs";
import { patch } from "../../modelPool/utils/patch";
import type {
  AgentDeliveryConfig,
  PilotDeckConfig,
} from "../../modelPool/types";
import {
  DELIVERY_DEFAULTS,
  DELIVERY_LIMITS,
  DELIVERY_NUMERIC_FIELDS,
  DELIVERY_PROMPT_MAX_BYTES,
  deliveryPromptByteLength,
  type DeliveryNumericField,
} from "../utils/deliveryConfig";

type DeliverySectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

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
      <path d="M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a8,8,0,0,1,17,17Z" />
    </svg>
  );
}

export default function DeliverySection({ config, onChange }: DeliverySectionProps) {
  const { t } = useTranslation("settings");
  const delivery: AgentDeliveryConfig = config.agent?.delivery ?? {};
  const autoMode = delivery.mode !== "off";
  const reviewerRef =
    typeof delivery.reviewerModel === "string" ? delivery.reviewerModel : "";
  const storedPrompt =
    typeof delivery.prompt === "string" ? delivery.prompt : undefined;
  const promptValue = storedPrompt ?? DEFAULT_DELIVERY_PROMPT;

  const reviewerOptions = buildModelRefOptions(config);
  if (
    reviewerRef !== ""
    && !reviewerOptions.some((option) => option.value === reviewerRef)
  ) {
    // Keep a stale/renamed reviewer ref selectable instead of silently
    // dropping it from the config on the next save.
    reviewerOptions.unshift({ value: reviewerRef, label: reviewerRef });
  }

  const setDelivery = (next: AgentDeliveryConfig) => {
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ) as AgentDeliveryConfig;
    const agent = { ...(config.agent ?? {}) };
    if (Object.keys(cleaned).length > 0) {
      agent.delivery = cleaned;
    } else {
      delete agent.delivery;
    }
    onChange(patch(config, ["agent"], agent));
  };

  const setAutoMode = (nextAuto: boolean) => {
    // "auto" is the backend default, so the key is stored only when off.
    setDelivery({ ...delivery, mode: nextAuto ? undefined : "off" });
  };

  const setReviewer = (nextRef: string) => {
    setDelivery({
      ...delivery,
      reviewerModel: nextRef === "" ? undefined : nextRef,
    });
  };

  const setPrompt = (nextPrompt: string) => {
    setDelivery({ ...delivery, prompt: nextPrompt });
  };

  const restoreDefaultPrompt = () => {
    // Deleting the stored field makes the host fall back to its built-in
    // default prompt; the textarea previews it until then.
    setDelivery({ ...delivery, prompt: undefined });
  };

  const setNumericField = (field: DeliveryNumericField, raw: string) => {
    if (raw === "") {
      // Cleared input means "use the backend default" → drop the key.
      setDelivery({ ...delivery, [field]: undefined });
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    setDelivery({ ...delivery, [field]: parsed });
  };

  return (
    <>
      <section
        className="route-card route-enable-card search-enable-card"
        aria-label={t("settingsPage.delivery.mode.label")}
      >
        <div className="route-card-heading">
          <div>
            <h2>{t("settingsPage.delivery.mode.label")}</h2>
            <p>{t("settingsPage.delivery.mode.description")}</p>
          </div>
          <SettingsToggle
            checked={autoMode}
            ariaLabel={t("settingsPage.delivery.mode.label")}
            onChange={setAutoMode}
            suppressNextSaveToast
          />
        </div>
      </section>

      <section
        className="search-card"
        aria-label={t("settingsPage.delivery.configAria")}
      >
        <div className={`search-config-body${autoMode ? "" : " disabled"}`}>
          <div className="search-setting-row">
            <div className="search-setting-copy">
              <label htmlFor="delivery-reviewer">
                {t("settingsPage.delivery.reviewer.label")}
              </label>
              <p>{t("settingsPage.delivery.reviewer.description")}</p>
            </div>
            <div className="search-control-area">
              <div className="search-select-wrap">
                <select
                  id="delivery-reviewer"
                  value={reviewerRef}
                  disabled={!autoMode}
                  onChange={(event) => setReviewer(event.target.value)}
                >
                  <option value="">
                    {t("settingsPage.delivery.reviewer.conversationModel")}
                  </option>
                  {reviewerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronIcon />
              </div>
            </div>
          </div>

          <div className="search-setting-row delivery-prompt-row">
            <div className="search-setting-copy">
              <label htmlFor="delivery-prompt">
                {t("settingsPage.delivery.prompt.label")}
              </label>
              <p>{t("settingsPage.delivery.prompt.description")}</p>
            </div>
            <div className="search-control-area">
              <textarea
                id="delivery-prompt"
                className="delivery-prompt-textarea"
                rows={12}
                disabled={!autoMode}
                value={promptValue}
                aria-describedby="delivery-prompt-status"
                onChange={(event) => setPrompt(event.target.value)}
              />
              <p
                id="delivery-prompt-status"
                role="status"
                className="text-xs text-muted-foreground"
              >
                {storedPrompt === undefined
                  ? t("settingsPage.delivery.prompt.usingDefault")
                  : storedPrompt.trim() === ""
                    ? t("settingsPage.delivery.prompt.blankStored")
                    : t("settingsPage.delivery.prompt.customStored", {
                        bytes: deliveryPromptByteLength(storedPrompt),
                        max: DELIVERY_PROMPT_MAX_BYTES,
                      })}
              </p>
              <button
                type="button"
                className="button secondary compact"
                disabled={!autoMode || storedPrompt === undefined}
                onClick={restoreDefaultPrompt}
              >
                {t("settingsPage.delivery.prompt.restore")}
              </button>
            </div>
          </div>

          <details className="delivery-budget-details">
            <summary>{t("settingsPage.delivery.budgets.summary")}</summary>
            {DELIVERY_NUMERIC_FIELDS.map((field) => (
              <div className="search-setting-row" key={field}>
                <div className="search-setting-copy">
                  <label htmlFor={`delivery-${field}`}>
                    {t(`settingsPage.delivery.budgets.${field}`)}
                  </label>
                </div>
                <div className="search-control-area">
                  <input
                    id={`delivery-${field}`}
                    type="number"
                    disabled={!autoMode}
                    min={DELIVERY_LIMITS[field].min}
                    max={DELIVERY_LIMITS[field].max}
                    value={delivery[field] ?? DELIVERY_DEFAULTS[field]}
                    onChange={(event) =>
                      setNumericField(field, event.target.value)
                    }
                  />
                </div>
              </div>
            ))}
          </details>
        </div>
      </section>
    </>
  );
}
