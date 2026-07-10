import { cn } from "../../../../lib/utils";
import { useTranslation } from "react-i18next";
import {
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "../../shared/view";
import type { CodeEditorSettingsState } from "../../shared/types";

type CodeEditorSectionProps = {
  codeEditorSettings: CodeEditorSettingsState;
  onWordWrapChange: (value: boolean) => void;
  onShowMinimapChange: (value: boolean) => void;
  onLineNumbersChange: (value: boolean) => void;
  onFontSizeChange: (value: string) => void;
};

function SelectControl({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-9 rounded-lg border border-transparent bg-muted px-3 text-[13px] font-medium text-foreground outline-none transition-colors",
        "hover:bg-accent focus:border-ring focus:bg-card focus:ring-1 focus:ring-ring",
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
    <section className="space-y-2.5">
      <PageSectionHeader title={t("appearanceSettings.codeEditor.title")} />
      <SettingsCard divided>
        <SettingsRow
          label={t("appearanceSettings.codeEditor.wordWrap.label")}
          description={t("appearanceSettings.codeEditor.wordWrap.description")}
        >
          <SettingsToggle
            checked={codeEditorSettings.wordWrap}
            onChange={onWordWrapChange}
            ariaLabel={t("appearanceSettings.codeEditor.wordWrap.label")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("appearanceSettings.codeEditor.showMinimap.label")}
          description={t("appearanceSettings.codeEditor.showMinimap.description")}
        >
          <SettingsToggle
            checked={codeEditorSettings.showMinimap}
            onChange={onShowMinimapChange}
            ariaLabel={t("appearanceSettings.codeEditor.showMinimap.label")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("appearanceSettings.codeEditor.lineNumbers.label")}
          description={t("appearanceSettings.codeEditor.lineNumbers.description")}
        >
          <SettingsToggle
            checked={codeEditorSettings.lineNumbers}
            onChange={onLineNumbersChange}
            ariaLabel={t("appearanceSettings.codeEditor.lineNumbers.label")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("appearanceSettings.codeEditor.fontSize.label")}
          description={t("appearanceSettings.codeEditor.fontSize.description")}
        >
          <SelectControl
            value={codeEditorSettings.fontSize}
            onChange={onFontSizeChange}
            options={["10", "11", "12", "13", "14", "15", "16", "18", "20"].map(
              (size) => ({
                value: size,
                label: `${size}px`,
              }),
            )}
            className="w-32"
          />
        </SettingsRow>
      </SettingsCard>
    </section>
  );
}
