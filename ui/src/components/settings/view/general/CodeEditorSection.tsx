import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../shared/view";
import type { CodeEditorSettingsState } from "../../shared/types";
import { showSettingsSuccess } from "../../shared/SettingsSuccessToast";
import { GENERAL_CODE_EDITOR_ICON } from "./icons";

type CodeEditorSectionProps = {
  codeEditorSettings: CodeEditorSettingsState;
  onWordWrapChange: (value: boolean) => void;
  onShowMinimapChange: (value: boolean) => void;
  onLineNumbersChange: (value: boolean) => void;
  onFontSizeChange: (value: string) => void;
};

function ChevronIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

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

export default function CodeEditorSection({
  codeEditorSettings,
  onWordWrapChange,
  onShowMinimapChange,
  onLineNumbersChange,
  onFontSizeChange,
}: CodeEditorSectionProps) {
  const { t } = useTranslation("settings");

  return (
    <section className="general-section general-code-section">
      <article className="general-card">
        <header className="general-card-header">
          <span
            className="general-card-header-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: GENERAL_CODE_EDITOR_ICON }}
          />
          <h2>{t("appearanceSettings.codeEditor.title")}</h2>
        </header>

        <ToggleRow
          label={t("appearanceSettings.codeEditor.wordWrap.label")}
          description={t("appearanceSettings.codeEditor.wordWrap.description")}
          checked={codeEditorSettings.wordWrap}
          onChange={onWordWrapChange}
        />
        <ToggleRow
          label={t("appearanceSettings.codeEditor.showMinimap.label")}
          description={t("appearanceSettings.codeEditor.showMinimap.description")}
          checked={codeEditorSettings.showMinimap}
          onChange={onShowMinimapChange}
        />
        <ToggleRow
          label={t("appearanceSettings.codeEditor.lineNumbers.label")}
          description={t("appearanceSettings.codeEditor.lineNumbers.description")}
          checked={codeEditorSettings.lineNumbers}
          onChange={onLineNumbersChange}
        />

        <div className="general-setting-row general-font-row">
          <div className="general-setting-copy">
            <strong className="general-setting-title">
              {t("appearanceSettings.codeEditor.fontSize.label")}
            </strong>
            <p>{t("appearanceSettings.codeEditor.fontSize.description")}</p>
          </div>
          <div className="general-select-wrap compact">
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => {
                const value = event.target.value;
                onFontSizeChange(value);
                showSettingsSuccess(`编辑器字号已设为 ${value}px`);
              }}
            >
              {["10", "11", "12", "13", "14", "15", "16", "18", "20"].map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
        </div>
      </article>
    </section>
  );
}
