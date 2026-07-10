import { useTranslation } from "react-i18next";
import {
  PageSectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "../../../shared/view";
import { FormRow, TextInput } from "../../modelPool/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

type GatewayConfigSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function GatewayConfigSection({
  config,
  onChange,
}: GatewayConfigSectionProps) {
  const { t } = useTranslation("settings");
  const gateway = config.gateway ?? {};

  return (
    <div className="space-y-2.5">
      <PageSectionHeader
        title={t("pilotDeckConfig.panels.gateway.title")}
        description={t("pilotDeckConfig.panels.gateway.description")}
      />
      <SettingsCard divided>
        <SettingsRow
          label={t("pilotDeckConfig.panels.gateway.enabled.label")}
          description={t("pilotDeckConfig.panels.gateway.enabled.description")}
        >
          <SettingsToggle
            checked={Boolean(gateway.enabled)}
            ariaLabel={t("pilotDeckConfig.panels.gateway.enabled.label")}
            onChange={(value) =>
              onChange(patch(config, ["gateway", "enabled"], value))
            }
          />
        </SettingsRow>
        {gateway.enabled && (
          <FormRow
            label={t("pilotDeckConfig.panels.gateway.home.label")}
            description={t("pilotDeckConfig.panels.gateway.home.description")}
          >
            <TextInput
              value={gateway.home}
              placeholder="~/.pilotdeck/gateway"
              monospace
              onChange={(value) =>
                onChange(patch(config, ["gateway", "home"], value))
              }
            />
          </FormRow>
        )}
      </SettingsCard>
    </div>
  );
}
