import type { ReactNode } from "react";
import { Palette, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../../../../contexts/ThemeContext";
import { languages } from "../../../../i18n/languages";
import type { ProjectSortOrder } from "../../shared/types";
import {
  GENERAL_LANGUAGE_ICON,
  GENERAL_PROJECT_SORT_ICON,
} from "./icons";
import { showSettingsSuccess } from "../../shared/SettingsSuccessToast";

type ThemeMode = "system" | "light" | "dark";

type GeneralSettingsSectionProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
};

function ChevronIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}

function SelectControl({
  value,
  onChange,
  options,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "general-select-wrap compact" : "general-select-wrap"}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronIcon />
    </div>
  );
}

function SelectRow({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="general-setting-row general-select-row">
      <span className="general-setting-icon">{icon}</span>
      <div className="general-setting-copy">
        <strong className="general-setting-title">{title}</strong>
        <p>{detail}</p>
      </div>
      {children}
    </div>
  );
}

export default function GeneralSettingsSection({
  projectSortOrder,
  onProjectSortOrderChange,
}: GeneralSettingsSectionProps) {
  const { t, i18n } = useTranslation("settings");
  const { themeMode = "system", setThemeMode } = useTheme() as {
    themeMode?: ThemeMode;
    setThemeMode?: (mode: ThemeMode) => void;
  };

  const currentLanguage = languages.some(
    (language) => language.value === i18n.language,
  )
    ? i18n.language
    : "en";

  return (
    <section className="general-section">
      <article className="general-card">
        <header className="general-card-header">
          <span className="general-card-header-icon">
            <SlidersHorizontal size={16} strokeWidth={1.8} />
          </span>
          <h2>{t("mainTabs.appearance")}</h2>
        </header>

        <SelectRow
          icon={<Palette size={16} strokeWidth={1.8} />}
          title={t("settingsHome.appearanceMode.title")}
          detail={t("settingsHome.appearanceMode.detail")}
        >
          <SelectControl
            value={themeMode}
            onChange={(value) => {
              setThemeMode?.(value as ThemeMode);
              const label = value === "light"
                ? t("settingsHome.appearanceMode.light")
                : value === "dark"
                  ? t("settingsHome.appearanceMode.dark")
                  : t("settingsHome.appearanceMode.system");
              showSettingsSuccess(`外观模式已切换为${label}`);
            }}
            options={[
              { value: "system", label: t("settingsHome.appearanceMode.system") },
              { value: "light", label: t("settingsHome.appearanceMode.light") },
              { value: "dark", label: t("settingsHome.appearanceMode.dark") },
            ]}
          />
        </SelectRow>

        <SelectRow
          icon={
            <span
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: GENERAL_LANGUAGE_ICON }}
            />
          }
          title={t("account.languageLabel")}
          detail={t("account.languageDescription")}
        >
          <SelectControl
            value={currentLanguage}
            onChange={(value) => {
              void i18n.changeLanguage(value).then(() => {
                const label =
                  languages.find((language) => language.value === value)
                    ?.nativeName ?? value;
                showSettingsSuccess(`语言已切换为${label}`);
              });
            }}
            options={languages.map((language) => ({
              value: language.value,
              label: language.nativeName,
            }))}
          />
        </SelectRow>

        <SelectRow
          icon={
            <span
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: GENERAL_PROJECT_SORT_ICON }}
            />
          }
          title={t("appearanceSettings.projectSorting.label")}
          detail={t("appearanceSettings.projectSorting.description")}
        >
          <SelectControl
            value={projectSortOrder}
            onChange={(value) => {
              onProjectSortOrderChange(value as ProjectSortOrder);
              const label = value === "name"
                ? t("appearanceSettings.projectSorting.alphabetical")
                : t("appearanceSettings.projectSorting.recentActivity");
              showSettingsSuccess(`项目排序已切换为${label}`);
            }}
            options={[
              {
                value: "name",
                label: t("appearanceSettings.projectSorting.alphabetical"),
              },
              {
                value: "date",
                label: t("appearanceSettings.projectSorting.recentActivity"),
              },
            ]}
          />
        </SelectRow>
      </article>
    </section>
  );
}
