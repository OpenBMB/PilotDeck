import type { FrontendModule } from '../contracts';
import OfficePreviewSections from '../../components/settings/view/officePreview';

const module: FrontendModule = {
  id: 'workspace.office-preview', businessModuleId: 'workspace.office-preview', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [{ id: 'office-preview', settingsSection: 'office-preview', label: 'Office preview', component: () => <OfficePreviewSections title="Office preview" /> }],
};
export default module;
