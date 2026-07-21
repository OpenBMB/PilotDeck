import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import type { SettingsNewMenuKey } from "../types";

type SettingsNewMenuItemI18n = {
  key: SettingsNewMenuKey;
  labelKey: string;
  children?: SettingsNewMenuItemI18n[];
  showDot?: boolean;
};

const MENU_ITEMS: SettingsNewMenuItemI18n[] = [
  { key: "general", labelKey: "settingsNew.menu.general" },
  { key: "modelPool", labelKey: "settingsNew.menu.modelPool" },
  {
    key: "agent",
    labelKey: "settingsNew.menu.agent",
    children: [
      { key: "agentModel", labelKey: "settingsNew.menu.agentModel" },
      { key: "agentRoute", labelKey: "settingsNew.menu.agentRoute" },
      { key: "agentMemory", labelKey: "settingsNew.menu.agentMemory" },
      { key: "agentResident", labelKey: "settingsNew.menu.agentResident" },
      { key: "agentSearch", labelKey: "settingsNew.menu.agentSearch" },
      { key: "agentSchedule", labelKey: "settingsNew.menu.agentSchedule" },
    ],
  },
  { key: "integrations", labelKey: "settingsNew.menu.integrations" },
  { key: "extensions", labelKey: "settingsNew.menu.extensions" },
  { key: "privacy", labelKey: "settingsNew.menu.privacy" },
  { key: "advanced", labelKey: "settingsNew.menu.advanced" },
  { key: "about", labelKey: "settingsNew.menu.about", showDot: true },
];

type SettingsNewSidebarProps = {
  selectedKey: SettingsNewMenuKey;
  onSelect: (key: SettingsNewMenuKey) => void;
  onClose: () => void;
  showAboutDot?: boolean;
};

const isItemActive = (
  item: SettingsNewMenuItemI18n,
  selectedKey: SettingsNewMenuKey,
): boolean => {
  if (item.key === selectedKey) return true;
  if (!item.children || item.children.length === 0) return false;
  return item.children.some((child) => child.key === selectedKey);
};

export default function SettingsNewSidebar({
  selectedKey,
  onSelect,
  onClose,
  showAboutDot = false,
}: SettingsNewSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <aside className="w-full shrink-0 border-r border-border bg-muted/20 md:w-[260px]">
      <div className="flex h-full flex-col">
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("settingsNew.backToApp")}
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5">
          <ul className="space-y-4">
            {MENU_ITEMS.map((item) => {
              const active = isItemActive(item, selectedKey);
              const hasChildren = Boolean(item.children?.length);
              return (
                <li key={item.key} className="space-y-2">
                  <button
                    type="button"
                    onClick={hasChildren ? undefined : () => onSelect(item.key)}
                    disabled={hasChildren}
                    className={cn(
                      "flex w-full items-center rounded-md px-3 py-1.5 text-left text-[16px] leading-7 tracking-[0.01em]",
                      hasChildren
                        ? "cursor-default"
                        : "cursor-pointer transition-colors hover:bg-muted hover:font-semibold",
                      active
                        ? "font-semibold text-foreground"
                        : "font-medium text-foreground/90",
                    )}
                  >
                    <span>{t(item.labelKey)}</span>
                    {item.showDot && showAboutDot ? (
                      <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />
                    ) : null}
                  </button>

                  {item.children && item.children.length > 0 ? (
                    <ul className="space-y-2">
                      {item.children.map((child) => (
                        <li key={child.key}>
                          <button
                            type="button"
                            onClick={() => onSelect(child.key)}
                            className={cn(
                              "flex w-full cursor-pointer items-center rounded-md py-1.5 pl-12 pr-3 text-left text-[16px] leading-7 tracking-[0.01em] transition-colors hover:bg-muted hover:font-semibold",
                              selectedKey === child.key
                                ? "font-semibold text-foreground"
                                : "font-medium text-foreground/90",
                            )}
                          >
                            {t(child.labelKey)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
