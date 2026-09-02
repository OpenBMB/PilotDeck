import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../../shared/view";

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
    <section
      className="security-section security-telemetry-section"
      aria-labelledby="security-telemetry-section-title"
    >
      <h2 id="security-telemetry-section-title">
        {t("settingsHome.telemetry.title")}
      </h2>
      <div className="security-card security-telemetry-card">
        <span className="security-telemetry-icon" aria-hidden="true">
          <Share2 size={19} />
        </span>
        <div className="security-telemetry-copy">
          <strong>{t("permissions.telemetry.title")}</strong>
          <p>{t("permissions.telemetry.description")}</p>
        </div>
        <SettingsToggle
          checked={enabled}
          onChange={onToggle}
          ariaLabel={t("permissions.telemetry.title")}
          disabled={loading}
          suppressNextSaveToast
        />
      </div>
    </section>
  );
}
