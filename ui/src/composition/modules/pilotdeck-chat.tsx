import type { FrontendModule } from '../contracts';
import ChatInterfaceV2 from '../../components/chat-v2/ChatInterfaceV2';

const module: FrontendModule = {
  id: 'pilotdeck.chat', slot: 'agentLoop', contract: 'pilotdeck.agent-loop/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  chatSurface: { id: 'pilotdeck.chat-v2', component: ChatInterfaceV2 },
};
export default module;
