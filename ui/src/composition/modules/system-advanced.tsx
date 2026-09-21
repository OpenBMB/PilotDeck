import type { FrontendModule } from '../contracts';
import AdvancedSections from '../../components/settings/view/advanced';

const module: FrontendModule = {
  id: 'system.advanced', businessModuleId: 'system.advanced', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [{ id: 'system-advanced', settingsSection: 'system-advanced', label: 'Advanced', component: () => <AdvancedSections title="Advanced" /> }],
};
export default module;
