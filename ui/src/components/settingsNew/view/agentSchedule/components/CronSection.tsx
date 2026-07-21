import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from "../../../shared/view";
import { FormRow, NumberInput, TextInput } from "../../../shared/components/Inputs";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import { isCronConfigEnabled } from "../utils/cron";

type CronSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

export default function CronSection({ config, onChange }: CronSectionProps) {
  const { t } = useTranslation("settings");
  const cron = config.cron ?? {};
  const enabled = isCronConfigEnabled(config);

  return (
    <SettingsSection>
      <p className="text-sm text-muted-foreground">
        {t("pilotDeckConfig.panels.cron.description")}
      </p>
      <SettingsCard divided>
        <SettingsRow
          label={t("pilotDeckConfig.panels.cron.enabled.label")}
          description={t("pilotDeckConfig.panels.cron.enabled.description")}
        >
          <SettingsToggle
            checked={enabled}
            ariaLabel={t("pilotDeckConfig.panels.cron.enabled.label")}
            onChange={(value) => onChange(patch(config, ["cron", "enabled"], value))}
          />
        </SettingsRow>
        <FormRow
          label={t("pilotDeckConfig.panels.cron.timezone.label")}
          description={t("pilotDeckConfig.panels.cron.timezone.description")}
        >
          <TextInput
            value={cron.timezone}
            placeholder="Asia/Shanghai"
            monospace
            onChange={(value) =>
              onChange(patch(config, ["cron", "timezone"], value || undefined))
            }
          />
        </FormRow>
        <FormRow
          label={t("pilotDeckConfig.panels.cron.maxConcurrentRuns.label")}
          description={t("pilotDeckConfig.panels.cron.maxConcurrentRuns.description")}
        >
          <NumberInput
            value={cron.maxConcurrentRuns}
            placeholder="2"
            onChange={(value) =>
              onChange(patch(config, ["cron", "maxConcurrentRuns"], value))
            }
          />
        </FormRow>
      </SettingsCard>
    </SettingsSection>
  );
}
