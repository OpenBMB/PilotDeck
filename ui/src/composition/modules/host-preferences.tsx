import type { FrontendModule } from '../contracts';
import HostPreferencesSections from '../../components/settings/view/general/HostPreferencesSections';
const module: FrontendModule = { id: 'host.preferences', businessModuleId: 'host.preferences', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', settings: [{ id: 'host-preferences', settingsSection: 'host-preferences', label: 'General', component: HostPreferencesSections }] };
export default module;
