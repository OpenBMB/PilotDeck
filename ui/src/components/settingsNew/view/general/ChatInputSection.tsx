import { useTranslation } from "react-i18next";
import { useUiPreferences } from "../../../../hooks/useUiPreferences";
import {
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "../../shared/view";

export default function ChatInputSection() {
  const { t } = useTranslation("settings");
  const { preferences, setPreference } = useUiPreferences();

  return (
    <section className="space-y-2.5">
      <PageSectionHeader title={t("settingsHome.chatInput.title")} />
      <div className="space-y-8">
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
      </div>
    </section>
  );
}
