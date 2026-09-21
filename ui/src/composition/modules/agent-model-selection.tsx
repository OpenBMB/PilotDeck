import type { FrontendModule } from '../contracts';
import AgentModelSections from '../../components/settings/view/agentModel';

const module: FrontendModule = {
  id: 'agent.model-selection', businessModuleId: 'agent.model-selection', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop', 'modelProvider'],
  settings: [{ id: 'agent-model', settingsSection: 'agent-model', label: 'Agent model', component: () => <AgentModelSections title="Agent model" /> }],
};
export default module;
