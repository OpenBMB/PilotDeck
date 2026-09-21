import type { FrontendModule } from '../contracts';
import ChatInputSection from '../../components/settings/view/general/ChatInputSection';
const module: FrontendModule = { id: 'chat.preferences', businessModuleId: 'chat.preferences', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop'], settings: [{ id: 'chat-preferences', settingsSection: 'chat-preferences', label: 'Chat preferences', component: ChatInputSection }] };
export default module;
