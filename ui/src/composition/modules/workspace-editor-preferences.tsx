import type { FrontendModule } from '../contracts';
import EditorPreferencesSections from '../../components/settings/view/general/EditorPreferencesSections';
const module: FrontendModule = { id: 'workspace.editor-preferences', businessModuleId: 'workspace.editor-preferences', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', settings: [{ id: 'workspace-editor-preferences', settingsSection: 'workspace-editor-preferences', label: 'Editor preferences', component: EditorPreferencesSections }] };
export default module;
