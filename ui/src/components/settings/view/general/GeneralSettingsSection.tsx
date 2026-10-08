import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { languages } from "../../../../i18n/languages";
import type { ProjectSortOrder } from "../../shared/types";
import { showSettingsSuccess } from "../../shared/SettingsSuccessToast";
import { GeneralCardHeader, GeneralSettingsIcon, GeneralSelectControl as SelectControl, GeneralSettingRow as SelectRow } from "../../shared/view/GeneralSettingsPrimitives";
import {
  GENERAL_LANGUAGE_ICON,
  GENERAL_PROJECT_SORT_ICON,
} from "./icons";


type GeneralSettingsSectionProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
};

export default function GeneralSettingsSection({
  projectSortOrder,
  onProjectSortOrderChange,
}: GeneralSettingsSectionProps) {
  const { t, i18n } = useTranslation("settings");
  const currentLanguage = languages.some(
    (language) => language.value === i18n.language,
  )
    ? i18n.language
    : "en";

  return (
    <section className="general-section">
      <article className="general-card">
        <GeneralCardHeader icon={<GeneralSettingsIcon icon={SlidersHorizontal} />} title={t("settingsPage.menu.general")} />

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
            ariaLabel={t("account.languageLabel")}
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
            ariaLabel={t("appearanceSettings.projectSorting.label")}
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
