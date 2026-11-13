/**
 * `staffdeck-knowledge` plugin entry.
 *
 * Reuses the StaffDeck 知识库 page as already vendored and host-adapted in
 * `ui/src/composition/modules/staffdeck` — the same composition the in-tree
 * module would render — but exposes it through the third-party UI page plugin
 * contract instead of the composition profile.
 *
 * Routes:
 *   /knowledge      → KnowledgePage (knowledge base management list)
 *   /knowledge/new  → KnowledgeNewPage (upload docs to create a new KB)
 */
import { Route, Routes } from 'react-router-dom';
import SharedKnowledgePage from './vendor/KnowledgePage';
import KnowledgeNewPage from './vendor/KnowledgeNewPage';
import { PilotDeckKnowledgePageProvider } from './vendor/knowledge-host-adapter';
import StaffDeckLocaleBoundary from '../../staffdeck-shared/vendor/locale/StaffDeckLocaleBoundary';
import { StaffDeckHostBinding } from '../../../src/composition/modules/staffdeck-host-binding';
import { mountPlugin, unmountPlugin, type PluginApi, type PluginUser } from '../../shared/plugin-bootstrap';

function PluginRoutes({ currentUser }: { currentUser: PluginUser | undefined }) {
  return (
    <Routes>
      <Route path="/knowledge" element={<SharedKnowledgePage currentUser={currentUser} />} />
      <Route path="/knowledge/new" element={<KnowledgeNewPage currentUser={currentUser} />} />
    </Routes>
  );
}

export function mount(container: HTMLElement, api: PluginApi) {
  return mountPlugin(container, api, {
    initialPath: '/knowledge',
    render: (currentUser: PluginUser | undefined, pluginApi: PluginApi) => (
      <StaffDeckHostBinding>
        <StaffDeckLocaleBoundary language={pluginApi.context.language}>
          <PilotDeckKnowledgePageProvider>
            <PluginRoutes currentUser={currentUser} />
          </PilotDeckKnowledgePageProvider>
        </StaffDeckLocaleBoundary>
      </StaffDeckHostBinding>
    ),
  });
}

export { unmountPlugin as unmount };
