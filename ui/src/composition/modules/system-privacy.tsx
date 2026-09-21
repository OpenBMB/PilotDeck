import type { FrontendModule } from '../contracts';
import PrivacySections from '../../components/settings/view/privacy';

const module: FrontendModule = {
  id: 'system.privacy', businessModuleId: 'system.privacy', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [{ id: 'system-privacy', settingsSection: 'system-privacy', label: 'Privacy', component: () => <PrivacySections title="Privacy" /> }],
};
export default module;
