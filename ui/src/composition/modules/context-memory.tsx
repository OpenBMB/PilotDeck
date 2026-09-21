import type { FrontendModule, SurfaceProps } from '../contracts';
import type { SettingsProject } from '../../components/settings/shared/types';
import AgentMemorySections from '../../components/settings/view/agentMemory';
import MemoryPanel from '../../components/main-content/view/memory/MemoryPanel';

const module: FrontendModule = {
  id: 'context.memory', businessModuleId: 'context.memory', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['context'],
  pages: [{ id: 'memory', path: '/memory', label: 'Memory', component: ({ host }: SurfaceProps) => <MemoryPanel selectedProject={(host?.selectedProject ?? null) as Parameters<typeof MemoryPanel>[0]['selectedProject']} /> }],
  settings: [{ id: 'context-memory', settingsSection: 'context-memory', label: 'Memory and compaction', component: ({ host }: SurfaceProps) => <AgentMemorySections title="Memory and compaction" projects={(host?.projects ?? []) as SettingsProject[]} /> }],
};
export default module;
