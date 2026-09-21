import type { FrontendModule } from '../contracts';
import ModelPoolSections from '../../components/settings/view/modelPool';
import AgentModelSections from '../../components/settings/view/agentModel';

function ModelProvidersSetting() { return <ModelPoolSections title="Model providers" />; }
function AgentModelSetting() { return <AgentModelSections title="Agent model" />; }

const module: FrontendModule = {
  id: 'pilotdeck.model', slot: 'modelProvider', contract: 'pilotdeck.model/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [
    { id: 'model-providers', settingsSection: 'model-providers', label: 'Model providers', component: ModelProvidersSetting },
    { id: 'agent-model', settingsSection: 'agent-model', label: 'Agent model', component: AgentModelSetting },
  ],
};
export default module;
