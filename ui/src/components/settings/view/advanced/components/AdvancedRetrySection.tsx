import { Pencil, Save, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PilotDeckConfig, V2Provider } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";

type RetryDraft = Required<NonNullable<V2Provider["retry"]>> & {
  judgeTimeoutMs: number;
};

type AdvancedRetrySectionProps = {
  config: PilotDeckConfig;
  onSave: (next: PilotDeckConfig) => Promise<boolean>;
  saving: boolean;
};

const RETRY_DEFAULTS: RetryDraft = {
  requestMaxRetries: 2,
  streamMaxRetries: 3,
  streamIdleTimeoutMs: 30_000,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  judgeTimeoutMs: 15_000,
};

function resolveProviderId(config: PilotDeckConfig): string | null {
  const providers = config.model?.providers ?? {};
  const modelRef = config.agent?.model?.trim();
  const slash = modelRef?.indexOf("/") ?? -1;
  const referencedProvider = slash > 0 ? modelRef?.slice(0, slash) : undefined;
  if (referencedProvider && providers[referencedProvider]) return referencedProvider;
  return Object.keys(providers)[0] ?? null;
}

function retryValues(config: PilotDeckConfig, providerId: string | null): RetryDraft {
  const retry = providerId ? config.model?.providers?.[providerId]?.retry : undefined;
  return {
    requestMaxRetries: retry?.requestMaxRetries ?? RETRY_DEFAULTS.requestMaxRetries,
    streamMaxRetries: retry?.streamMaxRetries ?? RETRY_DEFAULTS.streamMaxRetries,
    streamIdleTimeoutMs:
      retry?.streamIdleTimeoutMs ?? RETRY_DEFAULTS.streamIdleTimeoutMs,
    baseDelayMs: retry?.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs,
    maxDelayMs: retry?.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs,
    judgeTimeoutMs:
      config.router?.tokenSaver?.judgeTimeoutMs ?? RETRY_DEFAULTS.judgeTimeoutMs,
  };
}

export default function AdvancedRetrySection({
  config,
  onSave,
  saving,
}: AdvancedRetrySectionProps) {
  const { t } = useTranslation("settings");
  const providerId = useMemo(() => resolveProviderId(config), [config]);
  const current = useMemo(() => retryValues(config, providerId), [config, providerId]);
  const [draft, setDraft] = useState<RetryDraft | null>(null);
  const editing = draft !== null;
  const values = draft ?? current;

  const fields: Array<{
    key: keyof RetryDraft;
    translationKey: string;
  }> = [
    { key: "requestMaxRetries", translationKey: "requestMaxRetries" },
    { key: "streamMaxRetries", translationKey: "streamMaxRetries" },
    { key: "streamIdleTimeoutMs", translationKey: "streamIdleTimeoutMs" },
    { key: "judgeTimeoutMs", translationKey: "judgeTimeoutMs" },
    { key: "baseDelayMs", translationKey: "baseDelayMs" },
    { key: "maxDelayMs", translationKey: "maxDelayMs" },
  ];

  const commit = async () => {
    if (!draft || !providerId) return;
    let next = patch(config, ["model", "providers", providerId, "retry"], {
      requestMaxRetries: draft.requestMaxRetries,
      streamMaxRetries: draft.streamMaxRetries,
      streamIdleTimeoutMs: draft.streamIdleTimeoutMs,
      baseDelayMs: draft.baseDelayMs,
      maxDelayMs: draft.maxDelayMs,
    });
    next = patch(
      next,
      ["router", "tokenSaver", "judgeTimeoutMs"],
      draft.judgeTimeoutMs,
    );
    if (await onSave(next)) setDraft(null);
  };

  return (
    <section className="agent-retry-section" aria-labelledby="agent-retry-title">
      <header className="agent-retry-header">
        <span className="agent-retry-icon">
          <SlidersHorizontal size={20} />
        </span>
        <span>
          <strong id="agent-retry-title">
            {t("pilotDeckConfig.panels.advancedRetry.title")}
          </strong>
          <small>{t("pilotDeckConfig.panels.advancedRetry.description")}</small>
        </span>
        <div className="agent-retry-actions">
          {editing ? (
            <>
              <button
                className="button secondary compact"
                type="button"
                onClick={() => setDraft(null)}
                disabled={saving}
              >
                {t("settingsPage.actions.cancel")}
              </button>
              <button
                className="button primary compact"
                type="button"
                onClick={() => void commit()}
                disabled={saving || !providerId}
              >
                <Save size={16} />
                {t("actions.saveChanges")}
              </button>
            </>
          ) : (
            <button
              className="button secondary compact edit-provider-button"
              type="button"
              onClick={() => setDraft({ ...current })}
              disabled={!providerId}
            >
              <Pencil size={16} />
              {t("settingsPage.actions.edit")}
            </button>
          )}
        </div>
      </header>
      <div className="agent-retry-panel">
        {[fields.slice(0, 2), fields.slice(2, 4), fields.slice(4, 6)].map(
          (row, rowIndex) => (
            <div className="agent-retry-row" key={rowIndex}>
              {row.map((field) => (
                <label className="agent-retry-field" key={field.key}>
                  <span>
                    <strong>
                      {t(
                        `pilotDeckConfig.panels.advancedRetry.fields.${field.translationKey}.label`,
                      )}
                    </strong>
                    <small>
                      {t(
                        `pilotDeckConfig.panels.advancedRetry.fields.${field.translationKey}.description`,
                      )}
                    </small>
                  </span>
                  <input
                    min={0}
                    type="number"
                    value={values[field.key]}
                    disabled={!editing || saving}
                    onChange={(event) =>
                      setDraft((existing) =>
                        existing
                          ? {
                              ...existing,
                              [field.key]: Math.max(0, Number(event.target.value)),
                            }
                          : existing,
                      )
                    }
                  />
                </label>
              ))}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
