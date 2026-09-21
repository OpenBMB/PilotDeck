import { useCallback, useMemo } from "react";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { ConfigSaveError } from "../../shared/view";
import TelemetrySection from "./components/TelemetrySection";
import { readTelemetryEnabled, setTelemetryEnabled } from "./utils/telemetry";

type TelemetrySettingsSectionsProps = { title?: string };

export default function TelemetrySettingsSections({ title = "Telemetry" }: TelemetrySettingsSectionsProps) {
  const { raw, commitRaw, loading, error } = usePilotDeckConfig();
  const telemetryEnabled = useMemo(() => readTelemetryEnabled(raw), [raw]);
  const handleTelemetryToggle = useCallback((value: boolean) => {
    const nextRaw = setTelemetryEnabled(raw, value);
    if (nextRaw) void commitRaw(nextRaw);
  }, [commitRaw, raw]);
  return (
    <div className="security-page-content">
      <span className="sr-only">{title}</span>
      <ConfigSaveError error={error} />
      <TelemetrySection enabled={telemetryEnabled} loading={loading} onToggle={handleTelemetryToggle} />
    </div>
  );
}
