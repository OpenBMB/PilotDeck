import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import { cn } from "../../../lib/utils";
import type { DesktopVersionCheckResult } from "../Settings";
import type { SettingsMenuKey } from "../types";
import type { SettingsProject } from "../shared/types";
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

export default function SettingsContent({
  selectedKey,
  projects,
  versionInfo,
  checkingVersion,
  mobileVisible = true,
  onOpenMobileNavigation,
}: SettingsContentProps) {
  const { t } = useTranslation("settings");
  const title = t(MENU_TITLE_KEYS[selectedKey]);
  const isGeneral = selectedKey === "general";

  return (
    <section
      className={cn(
        "settings-content min-h-0 flex-1 overflow-y-auto bg-background pb-5 md:block",
        mobileVisible ? "block" : "hidden",
      )}
    >
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pb-6 pt-7">
        <button
          type="button"
          onClick={onOpenMobileNavigation}
          className="mb-5 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
        >
          <ChevronLeft className="h-4 w-4" />
          {t("settingsPage.backToSettings")}
        </button>
        {isGeneral ? (
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
          />
        ) : (
          <>
            <h2 className="text-2xl font-semibold text-foreground">
              {title}
            </h2>
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
          </>
        )}
      </div>
    </section>
  );
}
