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

type SettingsNewContentProps = {
  selectedKey: SettingsNewMenuKey;
  projects: SettingsProject[];
};

const MENU_TITLES: Record<SettingsNewMenuKey, string> = {
  general: '通用',
  modelPool: '模型池',
  agent: '智能体',
  agentModel: '智能体 / 模型',
  agentRoute: '智能体 / 路由',
  agentMemory: '智能体 / 记忆',
  agentResident: '智能体 / 常驻',
  agentSearch: '智能体 / 搜索',
  agentSchedule: '智能体 / 定时任务',
  integrations: '外部集成',
  extensions: '拓展',
  privacy: '安全隐私',
  advanced: '高级',
  about: '关于',
};

export default function SettingsNewContent({
  selectedKey,
  projects,
}: SettingsNewContentProps) {
  const isGeneral = selectedKey === "general";

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-background pb-5">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pb-6 pt-8">
        {isGeneral ? (
          <GeneralSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "agentModel" ? (
          <AgentModelSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "agentRoute" ? (
          <AgentRouteSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "agentMemory" ? (
          <AgentMemorySections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "agentResident" ? (
          <AgentResidentSections
            title={MENU_TITLES[selectedKey]}
            projects={projects}
          />
        ) : selectedKey === "agentSearch" ? (
          <AgentSearchSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "agentSchedule" ? (
          <AgentScheduleSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "integrations" ? (
          <IntegrationsSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "extensions" ? (
          <McpServersSection
            title={MENU_TITLES[selectedKey]}
            projects={projects}
          />
        ) : selectedKey === "modelPool" ? (
          <ModelPoolSections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "privacy" ? (
          <PrivacySections title={MENU_TITLES[selectedKey]} />
        ) : selectedKey === "advanced" ? (
          <AdvancedSections title={MENU_TITLES[selectedKey]} />
        ) : (
          <>
            <h2 className="text-2xl font-semibold text-foreground">
              {MENU_TITLES[selectedKey]}
            </h2>
            <div className="mt-6 flex min-h-[360px] flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  右侧内容区待接入
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  后续将按菜单项逐个填充设置项组件
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
