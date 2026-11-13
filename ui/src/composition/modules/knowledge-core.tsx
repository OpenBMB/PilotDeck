import type { FrontendModule } from '../contracts';
import { useTranslation } from 'react-i18next';
import KnowledgePage from '../../../plugins/staffdeck-knowledge/src/vendor/KnowledgePage';
import KnowledgeNewPage from '../../../plugins/staffdeck-knowledge/src/vendor/KnowledgeNewPage';
import { PilotDeckKnowledgePageProvider } from '../../../plugins/staffdeck-knowledge/src/vendor/knowledge-host-adapter';
import StaffDeckLocaleBoundary from '../../../plugins/staffdeck-shared/vendor/locale/StaffDeckLocaleBoundary';
import { StaffDeckHostBinding } from './staffdeck-host-binding';

function useStaffDeckProviders() {
  const { i18n } = useTranslation();
  const language = (i18n.language === 'en' ? 'en' : 'zh-CN') as 'zh-CN' | 'en';
  return ({ children }: { children: React.ReactNode }) => (
    <StaffDeckHostBinding>
      <StaffDeckLocaleBoundary language={language}>
        <PilotDeckKnowledgePageProvider>
          {children}
        </PilotDeckKnowledgePageProvider>
      </StaffDeckLocaleBoundary>
    </StaffDeckHostBinding>
  );
}

/** Knowledge base management list page — uses the vendored StaffDeck component directly. */
function Page() {
  const Providers = useStaffDeckProviders();
  return (
    <Providers>
      <KnowledgePage />
    </Providers>
  );
}

/** New knowledge base page — uses the vendored StaffDeck component directly. */
function NewPage() {
  const Providers = useStaffDeckProviders();
  return (
    <Providers>
      <KnowledgeNewPage />
    </Providers>
  );
}
const module: FrontendModule = {
  id: 'knowledge-core', slot: 'knowledge', contract: 'knowledge-core/v1', compatibleContracts: ['staffdeck.knowledge/v1'],
  source: 'third-party', frontendApiVersion: 'frontend-module/v1', buildMarker: 'knowledge-core.ui/v1',
  pages: [
    { id: 'knowledge', path: '/knowledge', label: 'Knowledge', component: Page },
    { id: 'knowledge-new', path: '/knowledge/new', label: 'New knowledge base', component: NewPage },
  ],
};
export default module;
