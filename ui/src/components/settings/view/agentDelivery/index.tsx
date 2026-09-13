import "./delivery.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import { ConfigSaveError } from "../../shared/view";
import DeliverySection from "./components/DeliverySection";
import {
  validateDelivery,
  type DeliveryValidationError,
} from "./utils/deliveryConfig";

type AgentDeliverySectionsProps = {
  title: string;
};

export default function AgentDeliverySections({
  title: _title,
}: AgentDeliverySectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, commitRaw, loading, saving, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  // Whole-page draft: mode, reviewer, prompt and budget edits all land in one
  // local config copy, so toggling the mode or reviewer can never discard an
  // unsaved prompt. Only the explicit Save button writes anything.
  const [draft, setDraft] = useState<PilotDeckConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    DeliveryValidationError[]
  >([]);
  const [formError, setFormError] = useState<string | null>(null);
  const syncedRawRef = useRef<string | null>(null);

  // Re-sync the draft whenever the saved config changes outside this page
  // (initial load, a successful save, edits from another settings page).
  // Unsaved local edits are never clobbered while dirty is true.
  useEffect(() => {
    if (loading || dirty || !parsedConfig) return;
    if (syncedRawRef.current === raw) return;
    syncedRawRef.current = raw;
    setDraft(parsedConfig);
  }, [loading, dirty, parsedConfig, raw]);

  if (loading) {
    return (
      <div className="delivery-page-content">
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="delivery-page-content">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.agentDelivery")}
        </div>
      </div>
    );
  }

  const onDraftChange = (next: PilotDeckConfig) => {
    setDraft(next);
    setDirty(true);
    setValidationErrors([]);
    setFormError(null);
  };

  const onSave = async () => {
    if (!draft) return;
    const errors = validateDelivery(draft.agent?.delivery ?? {});
    setValidationErrors(errors);
    if (errors.length > 0) return;
    try {
      setFormError(null);
      const result = await commitRaw(configToYamlString(draft));
      if (result && result.ok === false) {
        setFormError(result.error);
        return;
      }
      setDirty(false);
      // The sync effect above reloads the draft from the saved raw.
    } catch (caught) {
      setFormError(
        caught instanceof Error
          ? caught.message
          : "Failed to save agent delivery config",
      );
    }
  };

  return (
    <div className="delivery-page-content">
      <p className="text-xs text-muted-foreground" role="note">
        {t("settingsPage.delivery.effect")}
      </p>
      <ConfigSaveError error={error} />
      <ConfigSaveError error={formError} />
      {validationErrors.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p className="font-medium">
            {t("settingsPage.delivery.validationTitle")}
          </p>
          {validationErrors.map((validationError, index) => (
            <p key={index}>
              {t(
                validationError.key,
                validationError.params?.field
                  ? {
                      ...(validationError.params ?? {}),
                      field: t(String(validationError.params.field)),
                    }
                  : validationError.params,
              )}
            </p>
          ))}
        </div>
      ) : null}

      {draft ? (
        <DeliverySection config={draft} onChange={onDraftChange} />
      ) : null}

      <div className="delivery-save-row">
        <button
          type="button"
          className="button primary"
          disabled={!dirty || saving}
          onClick={() => void onSave()}
        >
          {saving
            ? t("settingsPage.delivery.saving")
            : t("settingsPage.actions.save")}
        </button>
        <p role="status" className="text-xs text-muted-foreground">
          {saving
            ? t("settingsPage.delivery.saving")
            : dirty
              ? t("settingsPage.delivery.unsaved")
              : null}
        </p>
      </div>
    </div>
  );
}
