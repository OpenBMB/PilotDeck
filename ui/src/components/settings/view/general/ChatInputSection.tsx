import { useTranslation } from "react-i18next";
import { useUiPreferences } from "../../../../hooks/useUiPreferences";
import { SettingsToggle } from "../../shared/view";
import { GENERAL_CHAT_ICON } from "./icons";

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="general-setting-row general-toggle-row">
      <div className="general-setting-copy">
        <strong className="general-setting-title">{label}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      <SettingsToggle checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

export default function ChatInputSection() {
  const { t } = useTranslation("settings");
  const { preferences, setPreference } = useUiPreferences();
  const updatePreference = (
    key: Parameters<typeof setPreference>[0],
    value: Parameters<typeof setPreference>[1],
  ) => {
    setPreference(key, value);
  };

  return (
    <section className="general-section">
      <article className="general-card">
        <header className="general-card-header">
          <span
            className="general-card-header-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: GENERAL_CHAT_ICON }}
          />
          <h2>{t("settingsHome.chatInput.title")}</h2>
        </header>

        <ToggleRow
          label={t("quickSettings.autoExpandTools")}
          checked={preferences.autoExpandTools}
          onChange={(value) => updatePreference("autoExpandTools", value)}
        />
        <ToggleRow
          label={t("quickSettings.showRawParameters")}
          checked={preferences.showRawParameters}
          onChange={(value) => updatePreference("showRawParameters", value)}
        />
        <ToggleRow
          label={t("quickSettings.showThinking")}
          checked={preferences.showThinking}
          onChange={(value) => updatePreference("showThinking", value)}
        />
        {preferences.showThinking ? (
          <ToggleRow
            label={t("quickSettings.inlineThinking")}
            checked={preferences.inlineThinking}
            onChange={(value) => updatePreference("inlineThinking", value)}
          />
        ) : null}
        <ToggleRow
          label={t("quickSettings.autoScrollToBottom")}
          checked={preferences.autoScrollToBottom}
          onChange={(value) => updatePreference("autoScrollToBottom", value)}
        />
        <ToggleRow
          label={t("quickSettings.sendByCtrlEnter")}
          description={t("quickSettings.sendByCtrlEnterDescription")}
          checked={preferences.sendByCtrlEnter}
          onChange={(value) => updatePreference("sendByCtrlEnter", value)}
        />
      </article>
    </section>
  );
}
