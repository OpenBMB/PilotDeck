import { useTranslation } from "react-i18next";
import type { SettingsProject } from "../../../shared/types";
import {
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "../../../shared/view";
import {
  getAlwaysOnProjectRoot,
  isAlwaysOnProjectEnabled,
  setAlwaysOnProjectEnabled,
} from "../../../shared/utils/alwaysOnConfigPatch";
import { FormRow, NumberInput, Select, TextInput } from "../../modelPool/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

type AlwaysOnSectionProps = {
  config: PilotDeckConfig;
  projects: SettingsProject[];
  onChange: (next: PilotDeckConfig) => void;
};

export default function AlwaysOnSection({
  config,
  projects,
  onChange,
}: AlwaysOnSectionProps) {
  const { t } = useTranslation("settings");
  const ao = config.alwaysOn ?? {};
  const trigger = ao.trigger ?? {};
  const dormancy = ao.dormancy ?? {};
  const workspace = ao.workspace ?? {};
  const execution = ao.execution ?? {};
  const enabled = ao.enabled === true;

  const projectRows = projects
    .map((project) => ({ project, root: getAlwaysOnProjectRoot(project) }))
    .filter((item) => item.root.length > 0);

  return (
    <SettingsSection>
      <div className="space-y-4 pb-6">
        <PageSectionHeader
          description={t("pilotDeckConfig.panels.alwaysOn.description")}
        />
        <SettingsCard>
          <SettingsRow
            label={t("pilotDeckConfig.panels.alwaysOn.enabled.label")}
            description={t("pilotDeckConfig.panels.alwaysOn.enabled.description")}
          >
            <SettingsToggle
              checked={enabled}
              ariaLabel={t("pilotDeckConfig.panels.alwaysOn.enabled.label")}
              onChange={(value) => onChange(patch(config, ["alwaysOn", "enabled"], value))}
            />
          </SettingsRow>
        </SettingsCard>

        {enabled && (
          <>
            <div className="space-y-2">
              <PageSectionHeader
                title={t("pilotDeckConfig.panels.alwaysOn.trigger.title")}
                description={t("pilotDeckConfig.panels.alwaysOn.trigger.description")}
              />
              <SettingsCard divided>
                <SettingsRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.autoDiscovery.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.autoDiscovery.description")}
                >
                  <SettingsToggle
                    checked={trigger.enabled === true}
                    ariaLabel={t("pilotDeckConfig.panels.alwaysOn.trigger.autoDiscovery.label")}
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "enabled"], value))
                    }
                  />
                </SettingsRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.tickInterval.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.tickInterval.description")}
                >
                  <NumberInput
                    value={trigger.tickIntervalMinutes}
                    placeholder="5"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "tickIntervalMinutes"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.cooldown.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.cooldown.description")}
                >
                  <NumberInput
                    value={trigger.cooldownMinutes}
                    placeholder="60"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "cooldownMinutes"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.dailyBudget.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.dailyBudget.description")}
                >
                  <NumberInput
                    value={trigger.dailyBudget}
                    placeholder="4"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "dailyBudget"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.heartbeatStale.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.heartbeatStale.description")}
                >
                  <NumberInput
                    value={trigger.heartbeatStaleSeconds}
                    placeholder="90"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "heartbeatStaleSeconds"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.recentUserMsg.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.recentUserMsg.description")}
                >
                  <NumberInput
                    value={trigger.recentUserMsgMinutes}
                    placeholder="5"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "recentUserMsgMinutes"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.description")}
                >
                  <Select
                    value={trigger.preferChannel}
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "trigger", "preferChannel"], value))
                    }
                    options={[
                      { value: "web", label: "Web UI" },
                      { value: "tui", label: "TUI" },
                    ]}
                  />
                </FormRow>
              </SettingsCard>
            </div>

            <div className="space-y-2">
              <PageSectionHeader
                title={t("pilotDeckConfig.panels.alwaysOn.dormancy.title")}
                description={t("pilotDeckConfig.panels.alwaysOn.dormancy.description")}
              />
              <SettingsCard divided>
                <SettingsRow
                  label={t("pilotDeckConfig.panels.alwaysOn.dormancy.enabled.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.dormancy.enabled.description")}
                >
                  <SettingsToggle
                    checked={dormancy.enabled !== false}
                    ariaLabel={t("pilotDeckConfig.panels.alwaysOn.dormancy.enabled.label")}
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "dormancy", "enabled"], value))
                    }
                  />
                </SettingsRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.dormancy.debounce.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.dormancy.debounce.description")}
                >
                  <NumberInput
                    value={dormancy.debounceMs}
                    placeholder="2000"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "dormancy", "debounceMs"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.dormancy.ignoreGlobs.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.dormancy.ignoreGlobs.description")}
                >
                  <textarea
                    value={(dormancy.ignoreGlobs ?? []).join("\n")}
                    placeholder={"**/.git/**\n**/node_modules/**\n**/.pilotdeck/**\n**/dist/**\n**/.DS_Store"}
                    onChange={(e) => {
                      const globs = e.target.value
                        .split("\n")
                        .filter((s) => s.trim().length > 0);
                      onChange(patch(config, ["alwaysOn", "dormancy", "ignoreGlobs"], globs));
                    }}
                    spellCheck={false}
                    className="min-h-[100px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </FormRow>
              </SettingsCard>
            </div>

            <div className="space-y-2">
              <PageSectionHeader
                title={t("pilotDeckConfig.panels.alwaysOn.workspace.title")}
                description={t("pilotDeckConfig.panels.alwaysOn.workspace.description")}
              />
              <SettingsCard divided>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.workspace.gitWorktree.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.workspace.gitWorktree.description")}
                >
                  <TextInput
                    value={workspace.gitWorktreeBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(value) =>
                      onChange(
                        patch(
                          config,
                          ["alwaysOn", "workspace", "gitWorktreeBaseDir"],
                          value || undefined,
                        ),
                      )
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.workspace.snapshotDir.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.workspace.snapshotDir.description")}
                >
                  <TextInput
                    value={workspace.snapshotBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(value) =>
                      onChange(
                        patch(config, ["alwaysOn", "workspace", "snapshotBaseDir"], value || undefined),
                      )
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.workspace.snapshotMaxBytes.label")}
                  description={t(
                    "pilotDeckConfig.panels.alwaysOn.workspace.snapshotMaxBytes.description",
                  )}
                >
                  <NumberInput
                    value={workspace.snapshotMaxBytes}
                    placeholder="1073741824"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "workspace", "snapshotMaxBytes"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.workspace.maxPlansPerCycle.label")}
                  description={t(
                    "pilotDeckConfig.panels.alwaysOn.workspace.maxPlansPerCycle.description",
                  )}
                >
                  <NumberInput
                    value={workspace.maxPlansPerCycle}
                    placeholder="3"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "workspace", "maxPlansPerCycle"], value))
                    }
                  />
                </FormRow>
                <SettingsRow
                  label={t("pilotDeckConfig.panels.alwaysOn.workspace.gitLfs.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.workspace.gitLfs.description")}
                >
                  <SettingsToggle
                    checked={workspace.gitLfs === true}
                    ariaLabel={t("pilotDeckConfig.panels.alwaysOn.workspace.gitLfs.label")}
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "workspace", "gitLfs"], value))
                    }
                  />
                </SettingsRow>
              </SettingsCard>
            </div>

            <div className="space-y-2">
              <PageSectionHeader
                title={t("pilotDeckConfig.panels.alwaysOn.execution.title")}
                description={t("pilotDeckConfig.panels.alwaysOn.execution.description")}
              />
              <SettingsCard divided>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.execution.maxTurns.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.execution.maxTurns.description")}
                >
                  <NumberInput
                    value={execution.maxTurns}
                    placeholder="30"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "execution", "maxTurns"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.execution.maxToolCalls.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.execution.maxToolCalls.description")}
                >
                  <NumberInput
                    value={execution.maxToolCalls}
                    placeholder="200"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "execution", "maxToolCalls"], value))
                    }
                  />
                </FormRow>
                <FormRow
                  label={t("pilotDeckConfig.panels.alwaysOn.execution.timeout.label")}
                  description={t("pilotDeckConfig.panels.alwaysOn.execution.timeout.description")}
                >
                  <NumberInput
                    value={execution.timeoutMinutes}
                    placeholder="20"
                    onChange={(value) =>
                      onChange(patch(config, ["alwaysOn", "execution", "timeoutMinutes"], value))
                    }
                  />
                </FormRow>
              </SettingsCard>
            </div>

            <div className="space-y-2">
              <PageSectionHeader
                title={t("pilotDeckConfig.panels.alwaysOn.workspaceOptIn.title")}
                description={t("pilotDeckConfig.panels.alwaysOn.workspaceOptIn.description")}
              />
              <SettingsCard divided>
                {projectRows.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    {t("pilotDeckConfig.panels.alwaysOn.workspaceOptIn.empty")}
                  </div>
                ) : (
                  projectRows.map(({ project, root }) => (
                    <SettingsRow
                      key={root}
                      label={project.displayName || project.name}
                      description={root}
                    >
                      <SettingsToggle
                        checked={isAlwaysOnProjectEnabled(config, project)}
                        ariaLabel={`Toggle Always-On for ${project.displayName || project.name}`}
                        onChange={(isEnabled) =>
                          onChange(setAlwaysOnProjectEnabled(config, project, isEnabled))
                        }
                      />
                    </SettingsRow>
                  ))
                )}
              </SettingsCard>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
