import type { FrontendModule, SurfaceProps } from '../contracts';
import type { SettingsProject } from '../../components/settings/shared/types';
import AgentMemorySections from '../../components/settings/view/agentMemory';

function ContextSetting({ host }: SurfaceProps) {
  return <AgentMemorySections title="Memory and compaction" projects={(host?.projects ?? []) as SettingsProject[]} />;
}

const module: FrontendModule = {
  id: 'pilotdeck.context', slot: 'context', contract: 'pilotdeck.context/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  settings: [{ id: 'context-memory', settingsSection: 'context-memory', label: 'Memory and compaction', component: ContextSetting }],
};
export default module;
