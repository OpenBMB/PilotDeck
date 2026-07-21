import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow, SettingsToggle } from "../../../shared/view";

type TelemetrySectionProps = {
  enabled: boolean;
  loading: boolean;
  onToggle: (value: boolean) => void;
};

export default function TelemetrySection({
  enabled,
  loading,
  onToggle,
}: TelemetrySectionProps) {
  const { t } = useTranslation("settings");

  return (
    <>
      <h3 className="text-xl font-semibold text-foreground">
        {t("settingsHome.telemetry.title")}
      </h3>
      <SettingsCard divided>
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              {t("settingsHome.telemetry.title")}
            </span>
          }
          description={t("settingsHome.telemetry.detail")}
        >
          <SettingsToggle
            checked={enabled}
            onChange={onToggle}
            ariaLabel={t("settingsHome.telemetry.title")}
            disabled={loading}
          />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
