import type { FrontendModule } from '../contracts';
import AgentScheduleSections from '../../components/settings/view/agentSchedule';
import CronV2 from '../../components/main-content-v2/CronV2';
import { ModulePage } from './shared';

function SchedulePage() {
  return <ModulePage title="Scheduled tasks" detail="Scheduled work is provided by the selected agent scheduling capability."><CronV2 /></ModulePage>;
}

const module: FrontendModule = {
  id: 'agent.scheduling', businessModuleId: 'agent.scheduling', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop'],
  pages: [{ id: 'scheduled-tasks', path: '/cron', label: 'Scheduled tasks', component: SchedulePage }],
  settings: [{ id: 'agent-schedule', settingsSection: 'agent-schedule', label: 'Schedules', component: () => <AgentScheduleSections title="Schedules" /> }],
};
export default module;
