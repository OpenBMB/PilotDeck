import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import type { SettingsMenuKey } from "../types";

type SettingsMenuItemI18n = {
  key: SettingsMenuKey;
  labelKey: string;
  children?: SettingsMenuItemI18n[];
  showDot?: boolean;
};

const MENU_ITEMS: SettingsMenuItemI18n[] = [
  { key: "general", labelKey: "settingsPage.menu.general" },
  { key: "modelPool", labelKey: "settingsPage.menu.modelPool" },
  {
    key: "agent",
    labelKey: "settingsPage.menu.agent",
    children: [
      { key: "agentModel", labelKey: "settingsPage.menu.agentModel" },
      { key: "agentRoute", labelKey: "settingsPage.menu.agentRoute" },
      { key: "agentMemory", labelKey: "settingsPage.menu.agentMemory" },
      { key: "agentResident", labelKey: "settingsPage.menu.agentResident" },
      { key: "agentSearch", labelKey: "settingsPage.menu.agentSearch" },
      { key: "agentSchedule", labelKey: "settingsPage.menu.agentSchedule" },
    ],
  },
  { key: "integrations", labelKey: "settingsPage.menu.integrations" },
  {
    key: "extensions",
    labelKey: "settingsPage.menu.extensions",
    children: [
      { key: "mcpServers", labelKey: "settingsPage.menu.mcpServers" },
      { key: "officePreview", labelKey: "settingsPage.menu.officePreview" },
    ],
  },
  { key: "privacy", labelKey: "settingsPage.menu.privacy" },
  { key: "advanced", labelKey: "settingsPage.menu.advanced" },
  { key: "about", labelKey: "settingsPage.menu.about", showDot: true },
];

type SettingsSidebarProps = {
  selectedKey: SettingsMenuKey;
  onSelect: (key: SettingsMenuKey) => void;
  onClose: () => void;
  showAboutDot?: boolean;
  mobileVisible?: boolean;
};

const isItemActive = (
  item: SettingsMenuItemI18n,
  selectedKey: SettingsMenuKey,
): boolean => {
  if (item.key === selectedKey) return true;
  if (!item.children || item.children.length === 0) return false;
  return item.children.some((child) => child.key === selectedKey);
};

export default function SettingsSidebar({
  selectedKey,
  onSelect,
  onClose,
  showAboutDot = false,
  mobileVisible = true,
}: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <aside
      className={cn(
        "h-full w-full shrink-0 border-r border-border bg-muted/20 md:block md:w-[260px]",
        mobileVisible ? "block" : "hidden",
      )}
    >
      <div className="flex h-full flex-col">
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("settingsPage.backToApp")}
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5">
          <ul className="space-y-3">
            {MENU_ITEMS.map((item) => {
              const active = isItemActive(item, selectedKey);
              const hasChildren = Boolean(item.children?.length);
              return (
                <li key={item.key} className="space-y-1">
                  <button
                    type="button"
                    onClick={hasChildren ? undefined : () => onSelect(item.key)}
                    disabled={hasChildren}
                    className={cn(
                      "flex min-h-8 w-full items-center rounded-md px-3 py-1 text-left text-sm leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      hasChildren
                        ? "cursor-default"
                        : "cursor-pointer transition-colors hover:bg-muted hover:text-foreground",
                      active
                        ? hasChildren
                          ? "font-semibold text-foreground"
                          : "bg-muted/80 font-medium text-foreground"
                        : hasChildren
                          ? "font-semibold text-foreground/90"
                          : "font-normal text-foreground/80",
                    )}
                  >
                    <span>{t(item.labelKey)}</span>
                    {item.showDot && showAboutDot ? (
                      <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />
                    ) : null}
                  </button>

                  {item.children && item.children.length > 0 ? (
                    <ul className="space-y-1">
                      {item.children.map((child) => (
                        <li key={child.key}>
                          <button
                            type="button"
                            onClick={() => onSelect(child.key)}
                            className={cn(
                              "flex min-h-8 w-full cursor-pointer items-center rounded-md py-1 pl-9 pr-3 text-left text-sm leading-5 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                              selectedKey === child.key
                                ? "bg-muted/80 font-medium text-foreground"
                                : "font-normal text-muted-foreground",
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
