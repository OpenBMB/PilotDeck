import type { FrontendModule, SurfaceProps } from '../contracts';
import type { SettingsProject } from '../../components/settings/shared/types';
import ChatInterfaceV2 from '../../components/chat-v2/ChatInterfaceV2';
import AgentRouteSections from '../../components/settings/view/agentRoute';
import AgentResidentSections from '../../components/settings/view/agentResident';
import AgentScheduleSections from '../../components/settings/view/agentSchedule';
import IntegrationsSections from '../../components/settings/view/integrations';

function AgentRouteSetting() { return <AgentRouteSections title="Agent routing" />; }
function AgentResidentSetting({ host }: SurfaceProps) { return <AgentResidentSections title="Always on" projects={(host?.projects ?? []) as SettingsProject[]} />; }
function AgentScheduleSetting() { return <AgentScheduleSections title="Schedules" />; }
function IntegrationsSetting() { return <IntegrationsSections title="Integrations" />; }

const module: FrontendModule = {
  id: 'pilotdeck.chat', slot: 'agentLoop', contract: 'pilotdeck.agent-loop/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  chatSurface: { id: 'pilotdeck.chat-v2', component: ChatInterfaceV2 },
  settings: [
    { id: 'agent-route', settingsSection: 'agent-route', label: 'Agent routing', component: AgentRouteSetting },
    { id: 'agent-resident', settingsSection: 'agent-resident', label: 'Always on', component: AgentResidentSetting },
    { id: 'agent-schedule', settingsSection: 'agent-schedule', label: 'Schedules', component: AgentScheduleSetting },
    { id: 'integrations', settingsSection: 'integrations', label: 'Integrations', component: IntegrationsSetting },
  ],
};
export default module;
