import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../../lib/utils";
import { SettingsCard } from "../../../shared/view";
import type { PilotDeckConfig } from "../../modelPool/types";
import { FormRow, NumberInput, TextInput } from "../../modelPool/components/Inputs";
import { patch } from "../../modelPool/utils/patch";

type ServiceSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function ServiceSection({ config, onChange }: ServiceSectionProps) {
  const { t } = useTranslation("settings");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const runtime = config.webui?.runtime ?? {};
  const setRuntime = (key: string, value: unknown) =>
    onChange(patch(config, ["webui", "runtime", key], value));

  return (
    <SettingsCard>
      <div className="divide-y divide-border">
        <FormRow
          label={t("pilotDeckConfig.panels.runtime.fields.host.label")}
          description={t("pilotDeckConfig.panels.runtime.fields.host.description")}
        >
          <TextInput
            value={runtime.host}
            placeholder="0.0.0.0"
            onChange={(value) => setRuntime("host", value)}
          />
        </FormRow>
        <FormRow
          label={t("pilotDeckConfig.panels.runtime.fields.serverPort.label")}
          description={t("pilotDeckConfig.panels.runtime.fields.serverPort.description")}
        >
          <NumberInput
            value={runtime.serverPort}
            placeholder="3001"
            onChange={(value) => setRuntime("serverPort", value)}
          />
        </FormRow>
        <FormRow
          label={t("pilotDeckConfig.panels.runtime.fields.workspacesRoot.label")}
          description={t("pilotDeckConfig.panels.runtime.fields.workspacesRoot.description")}
        >
          <TextInput
            value={runtime.workspacesRoot}
            placeholder="~"
            monospace
            onChange={(value) => setRuntime("workspacesRoot", value)}
          />
        </FormRow>
      </div>
      <div className="border-t border-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => setShowAdvanced((prev) => !prev)}
          aria-expanded={showAdvanced}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              showAdvanced && "rotate-180",
            )}
          />
          {t("pilotDeckConfig.panels.runtime.advancedToggle")}
        </button>
      </div>

      {showAdvanced ? (
        <div className="divide-y divide-border border-t border-border">
          <FormRow
            label={t("pilotDeckConfig.panels.runtime.fields.vitePort.label")}
            description={t("pilotDeckConfig.panels.runtime.fields.vitePort.description")}
          >
            <NumberInput
              value={runtime.vitePort}
              placeholder="5173"
              onChange={(value) => setRuntime("vitePort", value)}
            />
          </FormRow>
          <FormRow
            label={t("pilotDeckConfig.panels.runtime.fields.apiTimeout.label")}
            description={t("pilotDeckConfig.panels.runtime.fields.apiTimeout.description")}
          >
            <NumberInput
              value={runtime.apiTimeoutMs}
              placeholder="120000"
              onChange={(value) => setRuntime("apiTimeoutMs", value)}
            />
          </FormRow>
          <FormRow
            label={t("pilotDeckConfig.panels.runtime.fields.databasePath.label")}
            description={t("pilotDeckConfig.panels.runtime.fields.databasePath.description")}
          >
            <TextInput
              value={runtime.databasePath}
              placeholder="~/.pilotdeck/auth.db"
              monospace
              onChange={(value) => setRuntime("databasePath", value)}
            />
          </FormRow>
          <FormRow
            label={t("pilotDeckConfig.panels.runtime.fields.proxyUrl.label")}
            description={t("pilotDeckConfig.panels.runtime.fields.proxyUrl.description")}
          >
            <TextInput
              value={config.proxy?.url}
              placeholder="http://127.0.0.1:7890"
              monospace
              onChange={(value) => onChange(patch(config, ["proxy", "url"], value))}
            />
          </FormRow>
          <FormRow
            label={t("pilotDeckConfig.panels.runtime.fields.proxyNoProxy.label")}
            description={t("pilotDeckConfig.panels.runtime.fields.proxyNoProxy.description")}
          >
            <TextInput
              value={config.proxy?.noProxy}
              placeholder="127.0.0.1,localhost"
              monospace
              onChange={(value) => onChange(patch(config, ["proxy", "noProxy"], value))}
            />
          </FormRow>
        </div>
      ) : null}
    </SettingsCard>
  );
}
