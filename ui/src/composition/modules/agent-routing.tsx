import type { FrontendModule } from '../contracts';
import AgentRouteSections from '../../components/settings/view/agentRoute';

const module: FrontendModule = {
  id: 'agent.routing', businessModuleId: 'agent.routing', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop', 'modelProvider'],
  settings: [{ id: 'agent-route', settingsSection: 'agent-route', label: 'Agent routing', component: () => <AgentRouteSections title="Agent routing" /> }],
};
export default module;
