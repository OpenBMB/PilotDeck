import type { FrontendModule } from '../contracts';
import { authenticatedFetch } from '../../utils/api';
import KnowledgeFrame from './KnowledgeFrame';
import { useNavigate } from 'react-router-dom';

function headers(): Record<string, string> {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function directory() {
  const configuration = await authenticatedFetch('/api/modules/knowledge/core/configuration');
  if (!configuration.ok) throw new Error('Knowledge service unavailable');
  const capabilities = await configuration.json();
  let spaces = [];
  if (capabilities.modules.spaces) {
    const spacesResponse = await authenticatedFetch('/api/modules/knowledge/core/spaces');
    if (!spacesResponse.ok) throw new Error('Knowledge service unavailable');
    spaces = await spacesResponse.json();
  }
  const catalog = capabilities.operations.list_models
    ? await authenticatedFetch('/api/modules/knowledge/core/models' + (spaces[0] ? '?space_id=' + encodeURIComponent(spaces[0].id) : ''))
    : await authenticatedFetch('/api/modules/knowledge/capabilities/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!catalog.ok) throw new Error('Knowledge model catalog unavailable');
  const value = await catalog.json();
  const models = (Array.isArray(value) ? value : value.data).filter((row: { enabled?: boolean; available?: boolean }) => row.enabled !== false && row.available !== false);
  return { spaces, models, publishSuggestions: false, capabilities };
}
function notify(message: string, error: boolean) {
  window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: error ? 'error' : 'info', message } }));
}
function Page() {
  const navigate = useNavigate();
  return <KnowledgeFrame src="/km-ui/ui/v1/index.html" apiPath="/api/modules/knowledge/core" headers={headers} directory={directory} navigate={navigate} notify={notify} />;
}
const module: FrontendModule = {
  id: 'knowledge-core', slot: 'knowledge', contract: 'knowledge-core/v1', compatibleContracts: ['staffdeck.knowledge/v1'],
  source: 'third-party', frontendApiVersion: 'frontend-module/v1', buildMarker: 'knowledge-core.ui/v1',
  pages: [
    { id: 'knowledge', path: '/knowledge', label: 'Knowledge', component: Page },
    { id: 'knowledge-new', path: '/knowledge/new', label: 'New knowledge base', component: Page },
  ],
};
export default module;
