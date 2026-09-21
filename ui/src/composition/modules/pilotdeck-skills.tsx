import type { ComponentProps } from 'react';
import type { FrontendModule, SurfaceProps } from '../contracts';
import SkillsV2 from '../../components/main-content-v2/SkillsV2';

const BUILD_MARKER = 'pilotdeck.skills.ui/v1';

function SkillsContribution(props: SurfaceProps) {
  return <div data-module-build-marker={BUILD_MARKER}><SkillsV2
    selectedProject={(props.host?.selectedProject ?? null) as ComponentProps<typeof SkillsV2>['selectedProject']}
    projects={(props.host?.projects ?? []) as ComponentProps<typeof SkillsV2>['projects']}
  /></div>;
}

const module: FrontendModule = {
  id: 'pilotdeck.skills', slot: 'skills', contract: 'pilotdeck.skills/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  buildMarker: BUILD_MARKER,
  pages: [{ id: 'skills', path: '/skills', label: 'Skills', component: SkillsContribution }],
};
export default module;
