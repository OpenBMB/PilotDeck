import type { FrontendModule } from '../contracts';
import ModelPoolSections from '../../components/settings/view/modelPool';

const module: FrontendModule = {
  id: 'model.providers', businessModuleId: 'model.providers', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['modelProvider'],
  settings: [{ id: 'model-providers', settingsSection: 'model-providers', label: 'Model providers', component: () => <ModelPoolSections title="Model providers" /> }],
};
export default module;
