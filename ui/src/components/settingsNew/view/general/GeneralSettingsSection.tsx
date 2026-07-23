import type { ReactNode } from "react";
import {
  ArrowUpDown,
  Globe2,
  Palette,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../../../../contexts/ThemeContext";
import { languages } from "../../../../i18n/languages";
import { cn } from "../../../../lib/utils";
import { PageSectionHeader, SettingsCard } from "../../shared/view";
import type { ProjectSortOrder } from "../../shared/types";

type ThemeMode = "system" | "light" | "dark";

type GeneralSettingsSectionProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
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

function MenuRow({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[66px] items-center gap-3.5 px-5 py-3">
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
      <div className="flex-shrink-0">{children}</div>
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
    <section className="space-y-2.5">
      <PageSectionHeader title={t("mainTabs.appearance")} />
      <SettingsCard className="overflow-hidden bg-card/60" divided>
        <MenuRow
          icon={Palette}
          title={t("settingsHome.appearanceMode.title")}
          detail={t("settingsHome.appearanceMode.detail")}
        >
          <SelectControl
            value={themeMode}
            onChange={(value) => setThemeMode?.(value as ThemeMode)}
            options={[
              { value: "system", label: t("settingsHome.appearanceMode.system") },
              { value: "light", label: t("settingsHome.appearanceMode.light") },
              { value: "dark", label: t("settingsHome.appearanceMode.dark") },
            ]}
            className="w-44"
          />
        </MenuRow>

        <MenuRow
          icon={Globe2}
          title={t("account.languageLabel")}
          detail={t("account.languageDescription")}
        >
          <SelectControl
            value={currentLanguage}
            onChange={(value) => void i18n.changeLanguage(value)}
            options={languages.map((language) => ({
              value: language.value,
              label: language.nativeName,
            }))}
            className="w-44"
          />
        </MenuRow>

        <MenuRow
          icon={ArrowUpDown}
          title={t("appearanceSettings.projectSorting.label")}
          detail={t("appearanceSettings.projectSorting.description")}
        >
          <SelectControl
            value={projectSortOrder}
            onChange={(value) => onProjectSortOrderChange(value as ProjectSortOrder)}
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
            className="w-48"
          />
        </MenuRow>
      </SettingsCard>
    </section>
  );
}
