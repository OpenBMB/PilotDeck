import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { callPublicHost } from './public-host-mapping';
import { createFixedTargetContext } from '../../../../plugins/staffdeck-shared/vendor/copy-scope';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from '../../../../plugins/staffdeck-shared/vendor/dialog-primitives';

export type CitationSource = { document: Record<string, unknown>; chunks: Record<string, unknown>[] };
/** Read only exact locators through the authenticated selected-scope public facade. */
export async function resolveKnowledgeCitation(href: string, signal?: AbortSignal): Promise<CitationSource> {
  const url = new URL(href);
  const match = url.pathname.match(/^\/(documents|chunks)\/([^/]+)$/);
  if (url.protocol !== 'ultrarag:' || url.host !== 'knowledge' || url.username || url.password || !match || url.search || url.hash) throw new Error('KNOWLEDGE_CITATION_LOCATOR_INVALID');
  const id = decodeURIComponent(match[2]);
  const context = createFixedTargetContext();
  await context.loadDirectory({ signal });
  const scope = { kind: 'agent' as const, agentId: context.readScope() };
  const read = (operation: string, input: Record<string, unknown>, collection = true) => callPublicHost({ operation, input, collection }, scope, signal);
  const bases = await read('list_knowledge_bases', {}) as Array<{ id: string }>;
  for (const base of bases) {
    const documents = await read('list_knowledge_documents', { knowledgeBaseId: base.id }) as Array<{ id: string }>;
    for (const document of documents) {
      if (match[1] === 'documents' && document.id !== id) continue;
      const buckets = await read('list_document_buckets', { documentId: document.id }) as Array<{ id: string }>;
      const chunks: Record<string, unknown>[] = [];
      for (const bucket of buckets) {
        const rows = await read('list_bucket_chunks', { bucketId: bucket.id }) as Record<string, unknown>[];
        chunks.push(...rows);
      }
      const selected = match[1] === 'chunks' ? chunks.filter(chunk => chunk.id === id) : chunks;
      if (match[1] === 'chunks' && selected.length === 0) continue;
      const detail = await read('get_knowledge_document', { knowledgeBaseId: base.id, documentId: document.id }, false) as Record<string, unknown>;
      if (detail.id !== document.id) throw new Error('KNOWLEDGE_CITATION_RESPONSE_MISMATCH');
      return { document: detail, chunks: selected };
    }
  }
  throw new Error('KNOWLEDGE_CITATION_NOT_FOUND');
}

export function KnowledgeCitationLink({ href, children }: { href: string; children?: ReactNode }) {
  const { t } = useTranslation('staffdeck');
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<CitationSource>();
  const [error, setError] = useState('');
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const load = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOpen(true); setSource(undefined); setError('');
    void resolveKnowledgeCitation(href, controller.signal).then(value => {
      if (!controller.signal.aborted) setSource(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'KNOWLEDGE_CITATION_UNAVAILABLE');
    });
  };
  return <><a href={href} className="text-blue-600 hover:underline dark:text-blue-400" onClick={event => { event.preventDefault(); load(); }}>{children}</a>
    <PilotDeckDialog open={open} onOpenChange={value => { setOpen(value); if (!value) request.current?.abort(); }}>
      <PilotDeckDialogContent className="sm:max-w-2xl max-h-[80vh] overflow-auto">
        <PilotDeckDialogTitle>{t('knowledge.source', { defaultValue: 'Source document' })}</PilotDeckDialogTitle>
        {error ? <p role="alert">{t('knowledge.sourceUnavailable', { defaultValue: 'The exact cited source could not be loaded.' })} ({error})</p>
          : !source ? <p role="status">{t('knowledge.sourceLoading', { defaultValue: 'Loading source…' })}</p>
          : <div><h3>{String(source.document.title || source.document.filename || source.document.id)}</h3>
            <p className="text-xs break-all">{String(source.document.id)}</p>
            {source.chunks.map(chunk => <section key={String(chunk.id)} className="mt-3"><p className="text-xs break-all">{String(chunk.source_ref || chunk.id)}</p><pre className="whitespace-pre-wrap">{String(chunk.content || '')}</pre></section>)}
          </div>}
      </PilotDeckDialogContent>
    </PilotDeckDialog></>;
}
