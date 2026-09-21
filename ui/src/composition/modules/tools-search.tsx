import type { FrontendModule } from '../contracts';
import AgentSearchSections from '../../components/settings/view/agentSearch';

const module: FrontendModule = {
  id: 'tools.search', businessModuleId: 'tools.search', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['tools'],
  settings: [{ id: 'tools-search', settingsSection: 'tools-search', label: 'Tools and search', component: () => <AgentSearchSections title="Tools and search" /> }],
};
export default module;
