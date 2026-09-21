import type { FrontendModule, SurfaceProps } from '../contracts';
import type { SettingsProject } from '../../components/settings/shared/types';
import AgentResidentSections from '../../components/settings/view/agentResident';

const module: FrontendModule = {
  id: 'agent.resident', businessModuleId: 'agent.resident', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop'],
  settings: [{ id: 'agent-resident', settingsSection: 'agent-resident', label: 'Always on', component: ({ host }: SurfaceProps) => <AgentResidentSections title="Always on" projects={(host?.projects ?? []) as SettingsProject[]} /> }],
};
export default module;
