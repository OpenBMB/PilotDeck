import type { FrontendModule } from '../contracts';
import ToolPermissionsSections from '../../components/settings/view/privacy/ToolPermissionsSections';

const module: FrontendModule = {
  id: 'tools.permissions', businessModuleId: 'tools.permissions', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['tools'],
  settings: [{ id: 'tools-permissions', settingsSection: 'tools-permissions', label: 'Permissions', component: () => <ToolPermissionsSections title="Permissions" /> }],
};
export default module;
