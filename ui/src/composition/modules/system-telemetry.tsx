import type { FrontendModule } from '../contracts';
import TelemetrySettingsSections from '../../components/settings/view/privacy/TelemetrySettingsSections';

const module: FrontendModule = {
  id: 'system.telemetry', businessModuleId: 'system.telemetry', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [{ id: 'system-telemetry', settingsSection: 'system-telemetry', label: 'Telemetry', component: () => <TelemetrySettingsSections title="Telemetry" /> }],
};
export default module;
