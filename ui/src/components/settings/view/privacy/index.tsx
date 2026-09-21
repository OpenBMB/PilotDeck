import ToolPermissionsSections from "./ToolPermissionsSections";
import TelemetrySettingsSections from "./TelemetrySettingsSections";

export { ToolPermissionsSections, TelemetrySettingsSections };

/** Compatibility view for profiles that still select the pre-split module. */
export default function PrivacySections({ title }: { title: string }) {
  return (
    <div className="security-page-content">
      <ToolPermissionsSections title={title} />
      <TelemetrySettingsSections />
    </div>
  );
}
