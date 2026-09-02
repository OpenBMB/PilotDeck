import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import type { SettingsMenuKey } from "../types";
import {
  SETTINGS_BACK_ICON,
  SETTINGS_LOCAL_READY_ICON,
  SETTINGS_NAV_ICONS,
} from "./navIcons";

type NavItem = {
  key: SettingsMenuKey;
  labelKey: string;
  showDot?: boolean;
};

type NavSection = {
  id: string;
  titleKey?: string;
  nested?: boolean;
  items: NavItem[];
};

const PRIMARY_ITEMS: NavItem[] = [
  { key: "general", labelKey: "settingsPage.menu.general" },
  { key: "modelPool", labelKey: "settingsPage.menu.modelPool" },
];

const AGENT_ITEMS: NavItem[] = [
  { key: "agentRoute", labelKey: "settingsPage.menu.agentRoute" },
  { key: "agentMemory", labelKey: "settingsPage.menu.agentMemory" },
  { key: "agentResident", labelKey: "settingsPage.menu.agentResident" },
  { key: "agentSearch", labelKey: "settingsPage.menu.agentSearch" },
  { key: "agentSchedule", labelKey: "settingsPage.menu.agentSchedule" },
];

const EXTERNAL_ITEMS: NavItem[] = [
  { key: "integrations", labelKey: "settingsPage.menu.messageChannels" },
  { key: "mcpServers", labelKey: "settingsPage.menu.mcpServers" },
  { key: "officePreview", labelKey: "settingsPage.menu.officePreview" },
];

const FOOTER_ITEMS: NavItem[] = [
  { key: "privacy", labelKey: "settingsPage.menu.privacy" },
  { key: "advanced", labelKey: "settingsPage.menu.system" },
  { key: "about", labelKey: "settingsPage.menu.about", showDot: true },
];

const NAV_SECTIONS: NavSection[] = [
  { id: "primary", items: PRIMARY_ITEMS },
  { id: "agent", titleKey: "settingsPage.menu.agent", nested: true, items: AGENT_ITEMS },
  { id: "external", titleKey: "settingsPage.menu.external", nested: true, items: EXTERNAL_ITEMS },
];

type SettingsSidebarProps = {
  selectedKey: SettingsMenuKey;
  onSelect: (key: SettingsMenuKey) => void;
  onClose: () => void;
  showAboutDot?: boolean;
  mobileVisible?: boolean;
};

function SettingsIcon({ svg }: { svg: string }) {
  return (
    <span
      className="nav-icon"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function NavButton({
  item,
  selectedKey,
  onSelect,
  showAboutDot,
}: {
  item: NavItem;
  selectedKey: SettingsMenuKey;
  onSelect: (key: SettingsMenuKey) => void;
  showAboutDot: boolean;
}) {
  const { t } = useTranslation("settings");
  const active = item.key === selectedKey;
  const icon = SETTINGS_NAV_ICONS[item.key];

  return (
    <button
      type="button"
      onClick={() => onSelect(item.key)}
      className={cn("nav-item", active && "active")}
      aria-current={active ? "page" : undefined}
    >
      {icon ? <SettingsIcon svg={icon} /> : null}
      <span>{t(item.labelKey)}</span>
      {item.showDot && showAboutDot ? <i className="nav-dot" /> : null}
    </button>
  );
}

export default function SettingsSidebar({
  selectedKey,
  onSelect,
  onClose,
  showAboutDot = false,
  mobileVisible = true,
}: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <aside className={cn("settings-sidebar", !mobileVisible && "mobile-hidden")}>
      <div className="sidebar-brand">
        <img alt="PilotDeck" src="/pilotdeck-logo-lockup-transparent.png" />
      </div>

      <button type="button" className="back-to-app" onClick={onClose}>
        <SettingsIcon svg={SETTINGS_BACK_ICON} />
        <span>{t("settingsPage.backToProjects")}</span>
      </button>

      <nav className="settings-nav" aria-label={t("title")}>
        {NAV_SECTIONS.map((section) => (
          <section
            key={section.id}
            className={cn("nav-section", section.nested && "nav-section-nested")}
          >
            {section.titleKey ? <h2>{t(section.titleKey)}</h2> : null}
            <div className="nav-items">
              {section.items.map((item) => (
                <NavButton
                  key={item.key}
                  item={item}
                  selectedKey={selectedKey}
                  onSelect={onSelect}
                  showAboutDot={showAboutDot}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="nav-section settings-footer-links">
          <div className="nav-items">
            {FOOTER_ITEMS.map((item) => (
              <NavButton
                key={item.key}
                item={item}
                selectedKey={selectedKey}
                onSelect={onSelect}
                showAboutDot={showAboutDot}
              />
            ))}
          </div>
        </section>
      </nav>

      <div className="sidebar-footer">
        <SettingsIcon svg={SETTINGS_LOCAL_READY_ICON} />
        <strong>{t("settingsPage.status.localReady")}</strong>
      </div>
    </aside>
  );
}
