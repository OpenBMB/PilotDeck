import { useState } from 'react';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { ModulePage, ProfileTextSetting } from './shared';
import { authenticatedFetch } from '../../utils/api';

const BUILD_MARKER = 'staffdeck.knowledge.ui/v1';

function KnowledgePage(props: SurfaceProps) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [citation, setCitation] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      const response = await authenticatedFetch('/api/modules/knowledge/query', { method: 'POST', body: JSON.stringify({ query }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || 'Knowledge query failed.');
      setCitation(null);
      setResult(body.result ?? body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <ModulePage {...props} title="Knowledge" detail="StaffDeck Knowledge query and citation resolution use the selected backend module.">
    <span className="sr-only" data-module-build-marker={BUILD_MARKER} />
    <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the configured knowledge base" /><button className="rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={!query.trim()} onClick={() => void submit()}>Search</button></div>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    {result && <div className="mt-4 space-y-3">
      <pre className="overflow-auto rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800">{JSON.stringify(result, null, 2)}</pre>
      {(result.chunks ?? []).map((chunk: { id: string; content?: string; source_ref?: string }) => (
        <div key={chunk.id} className="flex items-start justify-between gap-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <div className="min-w-0"><p>{chunk.content}</p><p className="mt-1 text-xs text-neutral-500">{chunk.source_ref}</p></div>
          <button type="button" className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700" onClick={async () => {
            const response = await authenticatedFetch('/api/modules/knowledge/citation', { method: 'POST', body: JSON.stringify({ chunkId: chunk.id }) });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) { setError(body?.error?.message || 'Citation resolve failed.'); return; }
            setCitation(body.result ?? body);
          }}>Resolve citation</button>
        </div>
      ))}
      {citation && <pre className="overflow-auto rounded border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-900 dark:bg-emerald-950/30">{JSON.stringify(citation, null, 2)}</pre>}
    </div>}
  </ModulePage>;
}

function KnowledgeArtifactRenderer(props: SurfaceProps) {
  const artifact = props.artifact as { name?: string; path?: string } | undefined;
  return <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">Knowledge artifact: {artifact?.name ?? artifact?.path ?? 'citation'}</div>;
}

const module: FrontendModule = {
  id: 'staffdeck.knowledge', slot: 'knowledge', contract: 'staffdeck.knowledge/v1', source: 'staffdeck', frontendApiVersion: 'frontend-module/v1',
  buildMarker: BUILD_MARKER,
  requiresCapabilities: ['query'],
  pages: [{ id: 'knowledge', path: '/knowledge', label: 'Knowledge', component: KnowledgePage }],
  settings: [{ id: 'knowledge-default-base', settingsSection: 'knowledge', label: 'Knowledge', component: () => <ProfileTextSetting slot="knowledge" field="defaultBaseId" label="Default knowledge base" description="Used when a Knowledge query does not select a base." /> }],
  artifactRenderers: [{ id: 'staffdeck.knowledge-citation-artifact', label: 'Knowledge citation artifact', artifactMimeTypes: ['application/x-staffdeck-citation'], component: KnowledgeArtifactRenderer }],
};
export default module;
