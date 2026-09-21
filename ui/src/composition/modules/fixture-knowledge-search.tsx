import { useState } from 'react';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { ModulePage, ProfileTextSetting } from './shared';
import { authenticatedFetch } from '../../utils/api';

const BUILD_MARKER = 'fixture.knowledge-search.ui/v1';

function SearchFixture(props: SurfaceProps) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [citation, setCitation] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    setError(null);
    const response = await authenticatedFetch('/api/modules/knowledge/query', {
      method: 'POST', body: JSON.stringify({ query }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body?.error?.message || 'Replacement knowledge query failed.'); return; }
    setCitation(null);
    setResult(body.result ?? body);
  };
  return <ModulePage {...props} title="Knowledge search" detail="Independent replacement Knowledge implementation selected by the backend profile.">
    <span className="sr-only" data-module-build-marker={BUILD_MARKER} />
    <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the replacement knowledge service" /><button className="rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={!query.trim()} onClick={() => void search()}>Search</button></div>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    {result && <div className="mt-4 space-y-3"><pre className="overflow-auto rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800">{JSON.stringify(result, null, 2)}</pre>
      {(result.chunks ?? []).map((chunk: { id: string; content?: string }) => <div key={chunk.id} className="flex items-start justify-between gap-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"><p>{chunk.content}</p><button type="button" className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700" onClick={async () => {
        const response = await authenticatedFetch('/api/modules/knowledge/citation', { method: 'POST', body: JSON.stringify({ chunkId: chunk.id }) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) { setError(body?.error?.message || 'Replacement citation resolve failed.'); return; }
        setCitation(body.result ?? body);
      }}>Resolve citation</button></div>)}
      {citation && <pre className="overflow-auto rounded border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-900 dark:bg-emerald-950/30">{JSON.stringify(citation, null, 2)}</pre>}
    </div>}
  </ModulePage>;
}

const module: FrontendModule = {
  id: 'fixture.knowledge-search', slot: 'knowledge', contract: 'staffdeck.knowledge/v1', source: 'third-party', frontendApiVersion: 'frontend-module/v1',
  buildMarker: BUILD_MARKER,
  requiresCapabilities: ['query'],
  pages: [{ id: 'knowledge-search', path: '/knowledge-search', label: 'Knowledge search', component: SearchFixture }],
  settings: [{ id: 'replacement-knowledge-limit', settingsSection: 'knowledge', label: 'Knowledge search', component: () => <ProfileTextSetting slot="knowledge" field="resultLimit" label="Result limit" description="The selected replacement receives this limit for future searches." valueType="positiveInteger" /> }],
};
export default module;
