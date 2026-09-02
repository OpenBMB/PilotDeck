import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import { cn } from "../../../lib/utils";
import type { DesktopVersionCheckResult } from "../version";
import type { SettingsMenuKey } from "../types";
import type { SettingsProject } from "../shared/types";
import { SETTINGS_CONFIG_ICON } from "./navIcons";
import AgentModelSections from "./agentModel";
import AgentMemorySections from "./agentMemory";
import AgentResidentSections from "./agentResident";
import AgentRouteSections from "./agentRoute";
import AgentScheduleSections from "./agentSchedule";
import AgentSearchSections from "./agentSearch";
import AdvancedSections from "./advanced";
import McpServersSection from "./extensions";
import GeneralSections from "./general";
import IntegrationsSections from "./integrations";
import ModelPoolSections from "./modelPool";
import PrivacySections from "./privacy";
import AboutSections from "./about";
import OfficePreviewSections from "./officePreview";

type SettingsContentProps = {
  selectedKey: SettingsMenuKey;
  projects: SettingsProject[];
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
  onCloseSettings?: () => void;
  mobileVisible?: boolean;
  onOpenMobileNavigation?: () => void;
};

const MENU_TITLE_KEYS: Record<SettingsMenuKey, string> = {
  general: "settingsPage.titles.general",
  modelPool: "settingsPage.titles.modelPool",
  agent: "settingsPage.titles.agent",
  agentModel: "settingsPage.titles.agentModel",
  agentRoute: "settingsPage.titles.agentRoute",
  agentMemory: "settingsPage.titles.agentMemory",
  agentResident: "settingsPage.titles.agentResident",
  agentSearch: "settingsPage.titles.agentSearch",
  agentSchedule: "settingsPage.titles.agentSchedule",
  integrations: "settingsPage.titles.integrations",
  extensions: "settingsPage.titles.extensions",
  mcpServers: "settingsPage.titles.mcpServers",
  officePreview: "settingsPage.titles.officePreview",
  privacy: "settingsPage.titles.privacy",
  advanced: "settingsPage.titles.advanced",
  about: "settingsPage.titles.about",
};

const PAGE_HEADING_KEYS: Record<SettingsMenuKey, string> = {
  general: "settingsPage.menu.general",
  modelPool: "settingsPage.menu.modelPool",
  agent: "settingsPage.menu.agent",
  agentModel: "settingsPage.menu.agentModel",
  agentRoute: "settingsPage.menu.agentRoute",
  agentMemory: "settingsPage.menu.agentMemory",
  agentResident: "settingsPage.menu.agentResident",
  agentSearch: "settingsPage.menu.agentSearch",
  agentSchedule: "settingsPage.menu.agentSchedule",
  integrations: "settingsPage.menu.messageChannels",
  extensions: "settingsPage.menu.extensions",
  mcpServers: "settingsPage.menu.mcpServers",
  officePreview: "settingsPage.menu.officePreview",
  privacy: "settingsPage.menu.privacy",
  advanced: "settingsPage.menu.system",
  about: "settingsPage.menu.about",
};

const PAGE_DESCRIPTION_KEYS: Partial<Record<SettingsMenuKey, string>> = {
  general: "settingsPage.descriptions.general",
  modelPool: "settingsPage.descriptions.modelPool",
  agentModel: "settingsPage.descriptions.agentModel",
  agentRoute: "settingsPage.descriptions.agentRoute",
  agentMemory: "settingsPage.descriptions.agentMemory",
  agentResident: "settingsPage.descriptions.agentResident",
  agentSearch: "settingsPage.descriptions.agentSearch",
  agentSchedule: "settingsPage.descriptions.agentSchedule",
  integrations: "settingsPage.descriptions.integrations",
  mcpServers: "settingsPage.descriptions.mcpServers",
  officePreview: "settingsPage.descriptions.officePreview",
  privacy: "settingsPage.descriptions.privacy",
  advanced: "settingsPage.descriptions.advanced",
  about: "settingsPage.descriptions.about",
};

const PAGE_CLASS: Partial<Record<SettingsMenuKey, string>> = {
  general: "general-settings-page",
  modelPool: "model-pool-page",
  agentModel: "agent-model-page",
  agentRoute: "agent-route-page",
  agentMemory: "agent-memory-page",
  agentResident: "agent-resident-page",
  agentSearch: "agent-search-page",
  agentSchedule: "agent-scheduled-page",
  integrations: "integration-settings-page",
  mcpServers: "mcp-settings-page",
  officePreview: "office-settings-page",
  privacy: "security-settings-page",
  advanced: "advanced-settings-page",
  about: "about-settings-page",
};

export default function SettingsContent({
  selectedKey,
  projects,
  versionInfo,
  checkingVersion,
  onCloseSettings,
  mobileVisible = true,
  onOpenMobileNavigation,
}: SettingsContentProps) {
  const { t } = useTranslation("settings");
  const title = t(MENU_TITLE_KEYS[selectedKey]);
  const heading = t(PAGE_HEADING_KEYS[selectedKey]);
  const descriptionKey = PAGE_DESCRIPTION_KEYS[selectedKey];
  const pageClass = PAGE_CLASS[selectedKey];
  const isAgentSubpage = selectedKey.startsWith("agent") && selectedKey !== "agent";
  const isExternalIntegrationPage =
    selectedKey === "integrations" ||
    selectedKey === "mcpServers" ||
    selectedKey === "officePreview";

  return (
    <div className={cn("settings-main", !mobileVisible && "mobile-hidden")}>
      <header className="topbar">
        <div className="topbar-title">
          <span
            className="topbar-config-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: SETTINGS_CONFIG_ICON }}
          />
          <span>{t("settingsPage.breadcrumb")}</span>
          <span aria-hidden="true">›</span>
          {isAgentSubpage ? (
            <>
              <span>{t("settingsPage.menu.agent")}</span>
              <span aria-hidden="true">›</span>
            </>
          ) : null}
          {isExternalIntegrationPage ? (
            <>
              <span>{t("settingsPage.menu.integrations")}</span>
              <span aria-hidden="true">›</span>
            </>
          ) : null}
          <strong>{heading}</strong>
        </div>
      </header>

      <section className={cn("settings-page settings-content", pageClass)}>
        <button
          type="button"
          onClick={onOpenMobileNavigation}
          className="mobile-settings-back"
        >
          <ChevronLeft size={16} />
          {t("settingsPage.backToSettings")}
        </button>

        <header className={cn("page-header", selectedKey === "mcpServers" && "mcp-page-header")}>
          <div>
            <h1>{heading}</h1>
            {descriptionKey ? <p>{t(descriptionKey)}</p> : null}
          </div>
        </header>

        {selectedKey === "general" ? (
          <GeneralSections title={title} />
        ) : selectedKey === "agentModel" ? (
          <AgentModelSections title={title} />
        ) : selectedKey === "agentRoute" ? (
          <AgentRouteSections title={title} />
        ) : selectedKey === "agentMemory" ? (
          <AgentMemorySections title={title} projects={projects} />
        ) : selectedKey === "agentResident" ? (
          <AgentResidentSections title={title} projects={projects} />
        ) : selectedKey === "agentSearch" ? (
          <AgentSearchSections title={title} />
        ) : selectedKey === "agentSchedule" ? (
          <AgentScheduleSections title={title} />
        ) : selectedKey === "integrations" ? (
          <IntegrationsSections title={title} />
        ) : selectedKey === "mcpServers" ? (
          <McpServersSection title={title} projects={projects} />
        ) : selectedKey === "officePreview" ? (
          <OfficePreviewSections title={title} />
        ) : selectedKey === "modelPool" ? (
          <ModelPoolSections title={title} />
        ) : selectedKey === "privacy" ? (
          <PrivacySections title={title} />
        ) : selectedKey === "advanced" ? (
          <AdvancedSections title={title} />
        ) : selectedKey === "about" ? (
          <AboutSections
            title={title}
            versionInfo={versionInfo}
            checkingVersion={checkingVersion}
            onRestartConfirmed={onCloseSettings}
          />
        ) : (
          <div className="mt-6 flex min-h-[360px] flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {t("settingsPage.contentComingSoon.title")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settingsPage.contentComingSoon.description")}
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
