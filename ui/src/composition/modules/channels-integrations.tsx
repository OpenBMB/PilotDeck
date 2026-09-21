import type { FrontendModule } from '../contracts';
import IntegrationsSections from '../../components/settings/view/integrations';

const module: FrontendModule = {
  id: 'channels.integrations', businessModuleId: 'channels.integrations', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop'],
  settings: [{ id: 'integrations', settingsSection: 'integrations', label: 'Integrations', component: () => <IntegrationsSections title="Integrations" /> }],
};
export default module;
