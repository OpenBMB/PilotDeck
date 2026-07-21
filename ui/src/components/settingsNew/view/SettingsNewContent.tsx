import { useTranslation } from "react-i18next";
import type { DesktopVersionCheckResult } from "../SettingsNew";
import type { SettingsNewMenuKey } from "../types";
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

type SettingsNewContentProps = {
  selectedKey: SettingsNewMenuKey;
  projects: SettingsProject[];
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
};

const MENU_TITLE_KEYS: Record<SettingsNewMenuKey, string> = {
  general: "settingsNew.titles.general",
  modelPool: "settingsNew.titles.modelPool",
  agent: "settingsNew.titles.agent",
  agentModel: "settingsNew.titles.agentModel",
  agentRoute: "settingsNew.titles.agentRoute",
  agentMemory: "settingsNew.titles.agentMemory",
  agentResident: "settingsNew.titles.agentResident",
  agentSearch: "settingsNew.titles.agentSearch",
  agentSchedule: "settingsNew.titles.agentSchedule",
  integrations: "settingsNew.titles.integrations",
  extensions: "settingsNew.titles.extensions",
  privacy: "settingsNew.titles.privacy",
  advanced: "settingsNew.titles.advanced",
  about: "settingsNew.titles.about",
};

export default function SettingsNewContent({
  selectedKey,
  projects,
  versionInfo,
  checkingVersion,
}: SettingsNewContentProps) {
  const { t } = useTranslation("settings");
  const title = t(MENU_TITLE_KEYS[selectedKey]);
  const isGeneral = selectedKey === "general";

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-background pb-5">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pb-6 pt-8">
        {isGeneral ? (
          <GeneralSections title={title} />
        ) : selectedKey === "agentModel" ? (
          <AgentModelSections title={title} />
        ) : selectedKey === "agentRoute" ? (
          <AgentRouteSections title={title} />
        ) : selectedKey === "agentMemory" ? (
          <AgentMemorySections title={title} />
        ) : selectedKey === "agentResident" ? (
          <AgentResidentSections title={title} projects={projects} />
        ) : selectedKey === "agentSearch" ? (
          <AgentSearchSections title={title} />
        ) : selectedKey === "agentSchedule" ? (
          <AgentScheduleSections title={title} />
        ) : selectedKey === "integrations" ? (
          <IntegrationsSections title={title} />
        ) : selectedKey === "extensions" ? (
          <McpServersSection title={title} projects={projects} />
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
                  {t("settingsNew.contentComingSoon.title")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settingsNew.contentComingSoon.description")}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
