/**
 * `staffdeck-sop` plugin entry.
 *
 * Mirrors `FormalSopPage` / `FormalSopDistillPage` from
 * `ui/src/composition/modules/staffdeck-sop.tsx` — the StaffDeck SOP page with
 * its publish-runtime status — but exposed through the third-party UI page
 * plugin contract.
 *
 * Routes (the vendored pages navigate to the `/enterprise/skills...` paths,
 * so both those and the plugin-native `/sop...` aliases are registered):
 *   /enterprise/skills          → SkillsPage (SOP list)
 *   /enterprise/skills/distill  → DistillPage (create / edit workflow editor)
 *   /sop, /sop/distill          → same pages, kept as aliases
 */
import { Route, Routes } from 'react-router-dom';
import SharedSkillsPage from './vendor/SkillsPage';
import SharedDistillPage from './vendor/DistillPage';
import {
  PilotDeckDistillPageProvider,
  PilotDeckSkillsPageProvider,
} from './vendor/skills-host-adapter';
import { PublishRuntimeProvider } from '../../../src/composition/modules/staffdeck/publish-runtime-context';
import PublishRuntimeStatus from '../../../src/composition/modules/staffdeck/PublishRuntimeStatus';
import StaffDeckLocaleBoundary from '../../staffdeck-shared/vendor/locale/StaffDeckLocaleBoundary';
import { StaffDeckHostBinding } from '../../../src/composition/modules/staffdeck-host-binding';
import { mountPlugin, unmountPlugin, type PluginApi, type PluginUser } from '../../shared/plugin-bootstrap';

function PluginRoutes({ currentUser }: { currentUser: PluginUser | undefined }) {
  const skillsElement = (
    <PilotDeckSkillsPageProvider>
      <SharedSkillsPage currentUser={currentUser} />
    </PilotDeckSkillsPageProvider>
  );
  const distillElement = (
    <PilotDeckDistillPageProvider>
      <SharedDistillPage currentUser={currentUser} />
    </PilotDeckDistillPageProvider>
  );
  return (
    <Routes>
      <Route path="/enterprise/skills" element={skillsElement} />
      <Route path="/enterprise/skills/distill" element={distillElement} />
      <Route path="/sop" element={skillsElement} />
      <Route path="/sop/distill" element={distillElement} />
    </Routes>
  );
}

export function mount(container: HTMLElement, api: PluginApi) {
  return mountPlugin(container, api, {
    initialPath: '/sop',
    render: (currentUser: PluginUser | undefined, pluginApi: PluginApi) => (
      <StaffDeckHostBinding>
        <StaffDeckLocaleBoundary language={pluginApi.context.language}>
          <PublishRuntimeProvider>
            <PublishRuntimeStatus />
            <PluginRoutes currentUser={currentUser} />
          </PublishRuntimeProvider>
        </StaffDeckLocaleBoundary>
      </StaffDeckHostBinding>
    ),
  });
}

export { unmountPlugin as unmount };
