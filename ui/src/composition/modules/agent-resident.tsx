import { useCallback, useState } from 'react';
import type { FrontendModule, SurfaceProps } from '../contracts';
import type { SettingsProject } from '../../components/settings/shared/types';
import AgentResidentSections from '../../components/settings/view/agentResident';
import AlwaysOnV2 from '../../components/main-content-v2/AlwaysOnV2';
import type { AlwaysOnSubTab, Project } from '../../types/app';

function AlwaysOnPage({ host }: SurfaceProps) {
  const [subTab, setSubTab] = useState<AlwaysOnSubTab>('dashboard');
  const selectedProject = (host?.selectedProject as Project | undefined) ?? null;
  const openExecutionSession = useCallback(
    (projectKey: string, runId: string) => {
      const rawId = `always-on/execute:project=${projectKey}:run=${runId}`;
      const sessionId = rawId.replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
      host?.navigate?.(`/session/${encodeURIComponent(sessionId)}`);
    },
    [host],
  );

  return <AlwaysOnV2
    selectedProject={selectedProject}
    subTab={subTab}
    onSubTabChange={setSubTab}
    onOpenExecutionSession={openExecutionSession}
  />;
}

const module: FrontendModule = {
  id: 'agent.resident', businessModuleId: 'agent.resident', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['agentLoop'],
  pages: [{ id: 'always-on', path: '/always-on', label: 'Always On', component: AlwaysOnPage }],
  settings: [{ id: 'agent-resident', settingsSection: 'agent-resident', label: 'Always on', component: ({ host }: SurfaceProps) => <AgentResidentSections title="Always on" projects={(host?.projects ?? []) as SettingsProject[]} /> }],
};
export default module;
