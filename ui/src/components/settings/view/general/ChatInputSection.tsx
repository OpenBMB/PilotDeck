import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useUiPreferences } from "../../../../hooks/useUiPreferences";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import {
  DEFAULT_ATTACHMENT_UPLOAD_LIMITS,
  dispatchAttachmentUploadLimitsChanged,
  isValidAttachmentSizeMB,
  normalizeAttachmentUploadLimits,
} from "../../../chat/utils/attachmentUploadLimits";
import {
  ConfigSaveError,
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "../../shared/view";
import { NumberInput } from "../../shared/components/Inputs";
import type { PilotDeckConfig } from "../modelPool/types";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import { patch } from "../modelPool/utils/patch";

export default function ChatInputSection() {
  const { t } = useTranslation("settings");
  const { preferences, setPreference } = useUiPreferences();
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const config = useMemo(() => safeParseYaml(raw), [raw]);
  const maxFileSizeMB = config?.webui?.attachments?.maxFileSizeMB
    ?? DEFAULT_ATTACHMENT_UPLOAD_LIMITS.maxFileSizeMB;

  const setAttachmentSizeLimit = (value: number | undefined) => {
    if (!config || !isValidAttachmentSizeMB(value)) return;

    const nextConfig = patch<PilotDeckConfig>(
      config,
      ["webui", "attachments", "maxFileSizeMB"],
      value,
    );
    setRaw(configToYamlString(nextConfig));
    void save().then((result) => {
      if (result.ok) {
        dispatchAttachmentUploadLimitsChanged(normalizeAttachmentUploadLimits({
          maxFileSizeMB: value,
        }));
      }
    });
  };

  return (
    <section className="space-y-2.5">
      <PageSectionHeader title={t("settingsHome.chatInput.title")} />
      <div className="space-y-6">
        <SettingsSection title={t("quickSettings.sections.toolDisplay")}>
          <SettingsCard divided>
            <SettingsRow label={t("quickSettings.autoExpandTools")}>
              <SettingsToggle
                checked={preferences.autoExpandTools}
                onChange={(value) => setPreference("autoExpandTools", value)}
                ariaLabel={t("quickSettings.autoExpandTools")}
              />
            </SettingsRow>
            <SettingsRow label={t("quickSettings.showRawParameters")}>
              <SettingsToggle
                checked={preferences.showRawParameters}
                onChange={(value) => setPreference("showRawParameters", value)}
                ariaLabel={t("quickSettings.showRawParameters")}
              />
            </SettingsRow>
            <SettingsRow label={t("quickSettings.showThinking")}>
              <SettingsToggle
                checked={preferences.showThinking}
                onChange={(value) => setPreference("showThinking", value)}
                ariaLabel={t("quickSettings.showThinking")}
              />
            </SettingsRow>
            {preferences.showThinking ? (
              <SettingsRow label={t("quickSettings.inlineThinking")}>
                <SettingsToggle
                  checked={preferences.inlineThinking}
                  onChange={(value) => setPreference("inlineThinking", value)}
                  ariaLabel={t("quickSettings.inlineThinking")}
                />
              </SettingsRow>
            ) : null}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title={t("quickSettings.sections.viewOptions")}>
          <SettingsCard>
            <SettingsRow label={t("quickSettings.autoScrollToBottom")}>
              <SettingsToggle
                checked={preferences.autoScrollToBottom}
                onChange={(value) => setPreference("autoScrollToBottom", value)}
                ariaLabel={t("quickSettings.autoScrollToBottom")}
              />
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title={t("quickSettings.sections.inputSettings")}>
          <SettingsCard>
            <SettingsRow
              label={t("quickSettings.sendByCtrlEnter")}
              description={t("quickSettings.sendByCtrlEnterDescription")}
            >
              <SettingsToggle
                checked={preferences.sendByCtrlEnter}
                onChange={(value) => setPreference("sendByCtrlEnter", value)}
                ariaLabel={t("quickSettings.sendByCtrlEnter")}
              />
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title={t("quickSettings.sections.attachmentUpload")}>
          <ConfigSaveError error={error} />
          <SettingsCard>
            <SettingsRow
              label={t("quickSettings.attachmentMaxFileSize")}
              description={t("quickSettings.attachmentMaxFileSizeDescription")}
            >
              {config ? (
                <NumberInput
                  value={maxFileSizeMB}
                  placeholder="20"
                  min={1}
                  step={1}
                  allowEmpty={false}
                  isValid={isValidAttachmentSizeMB}
                  onChange={setAttachmentSizeLimit}
                />
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </SettingsRow>
          </SettingsCard>
          {loading || !config ? (
            <div className="text-xs text-muted-foreground">
              {loading
                ? t("pilotDeckConfig.loading")
                : t("quickSettings.attachmentConfigUnavailable")}
            </div>
          ) : null}
        </SettingsSection>
      </div>
    </section>
  );
}
