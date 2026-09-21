import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import pilotdeckLogoDark from "../../../assets/pilotdeck-wordmark-dark.png";
import pilotdeckLogoLight from "../../../assets/pilotdeck-wordmark-light.png";
import type { SettingsMenuKey } from "../types";
import type { Contribution } from "../../../composition/contracts";
import {
  SETTINGS_BACK_ICON,
  SETTINGS_NAV_ICONS,
} from "./navIcons";

type NavItem = {
  key: SettingsMenuKey;
  labelKey: string;
  label?: string;
  showDot?: boolean;
};

type NavSection = {
  id: string;
  titleKey?: string;
  nested?: boolean;
  items: NavItem[];
};

const SHELL_ITEMS: NavItem[] = [
  { key: "general", labelKey: "settingsPage.menu.general" },
];

const NAV_SECTIONS: NavSection[] = [
  { id: "shell", items: SHELL_ITEMS },
];

type SettingsSidebarProps = {
  selectedKey: SettingsMenuKey;
  onSelect: (key: SettingsMenuKey) => void;
  onClose: () => void;
  mobileVisible?: boolean;
  moduleSettings?: Contribution[];
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
}: {
  item: NavItem;
  selectedKey: SettingsMenuKey;
  onSelect: (key: SettingsMenuKey) => void;
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
      <span>{item.label ?? t(item.labelKey)}</span>
      {item.showDot ? <i className="nav-dot" /> : null}
    </button>
  );
}

export default function SettingsSidebar({
  selectedKey,
  onSelect,
  onClose,
  mobileVisible = true,
  moduleSettings = [],
}: SettingsSidebarProps) {
  const { t } = useTranslation("settings");

  return (
    <aside className={cn("settings-sidebar", !mobileVisible && "mobile-hidden")}>
      <div className="sidebar-brand">
        <img
          alt="PilotDeck"
          className="sidebar-brand-logo sidebar-brand-logo-light"
          src={pilotdeckLogoLight}
        />
        <img
          alt=""
          aria-hidden="true"
          className="sidebar-brand-logo sidebar-brand-logo-dark"
          src={pilotdeckLogoDark}
        />
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
                />
              ))}
            </div>
          </section>
        ))}
        {moduleSettings.length > 0 ? (
          <section className="nav-section nav-section-nested">
            <h2>Modules</h2>
            <div className="nav-items">
              {Array.from(new Map(moduleSettings.map((setting) => [setting.settingsSection || setting.id, setting])).values()).map((setting) => {
                const key = `module:${setting.settingsSection || setting.id}` as SettingsMenuKey;
                return <NavButton key={key} item={{ key, labelKey: '', label: setting.label }} selectedKey={selectedKey} onSelect={onSelect} />;
              })}
            </div>
          </section>
        ) : null}

      </nav>
    </aside>
  );
}
