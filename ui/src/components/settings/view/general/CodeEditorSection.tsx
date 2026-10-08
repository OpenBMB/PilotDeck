import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../shared/view";
import { GeneralSelectControl } from "../../shared/view/GeneralSettingsPrimitives";
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
          <GeneralSelectControl compact ariaLabel={t("appearanceSettings.codeEditor.fontSize.label")}
            value={codeEditorSettings.fontSize}
            onChange={value => { onFontSizeChange(value); showSettingsSuccess(`编辑器字号已设为 ${value}px`); }}
            options={["10", "11", "12", "13", "14", "15", "16", "18", "20"].map(size => ({ value: size, label: `${size}px` }))} />
        </div>
      </article>
    </section>
  );
}
