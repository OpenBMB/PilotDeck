/**
 * Host adapter for the StaffDeck KnowledgePage shared UI.
 *
 * Mirrors the skills-host-adapter.tsx pattern: the StaffDeck source defines a
 * `Host` contract in KnowledgePageHost.tsx; this adapter fills every Host
 * field with PilotDeck-local glue so the shared page renders inside a
 * PilotDeck shell (as a module or as a bundled UI page plugin).
 *
 * The `api` implementation routes per-staffdeck route:
 *   - model-configs            → public host (list_staffdeck_model_catalog)
 *   - /api/enterprise/agents   → copy context directory (list_agents)
 *   - /api/enterprise/knowledge-bases with agent_id → copy client list_knowledge_bases
 *   - everything else          → stub that throws a structured error until
 *     the PilotDeck module gateway exposes the matching operation. The UI
 *     already renders these errors as a banner, so the page still mounts.
 */
import * as React from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { usePilotDeckHostCapabilities } from '../../../../src/composition/modules/staffdeck/pilotdeck-host-capabilities';
import {
  callPublicHost,
  planPublicHost,
  selectedPublicScope,
} from '../../../../src/composition/modules/staffdeck/public-host-mapping';
import { authenticatedFetch } from '../../../../src/utils/api';
import {
  staffDeckCopyClient,
  staffDeckKnowledgeClient,
  type ModuleRequestOptions,
} from '../../../../src/composition/modules/staffdeck/clients';
import { staffDeckNotify } from '../../../../src/composition/modules/staffdeck/host-notify';
import {
  createFixedTargetContext,
  type CopyContext,
} from '../../../staffdeck-shared/vendor/copy-scope';
import {
  pilotDeckFormalComponents,
  pilotDeckFormalIcons,
} from '../../../staffdeck-shared/vendor/host-components';
import { KnowledgePageHostProvider } from './KnowledgePageHost';
import type { KnowledgePageHost } from './KnowledgePageHost';

// PilotDeck local tenant id for the single-user host identity.
export const PILOTDECK_KNOWLEDGE_TENANT_ID = 'pilotdeck-local';

// ---- agent scope local store ------------------------------------------------
// KnowledgePage persists the selected agent id so refresh/navigation returns.
// PilotDeck is single-user but the selection still changes when switching
// between employees in the shared page.

const AGENT_SCOPE_STORAGE_KEY = 'pilotdeck.knowledge.agent_scope';
const AGENT_SCOPE_EVENT = 'ultrarag-enterprise-agent-scope-change';

function readPersistedAgentScope(userId?: string): string {
  try {
    const stored = window.localStorage.getItem(AGENT_SCOPE_STORAGE_KEY);
    if (!stored) return '';
    const parsed = JSON.parse(stored) as { userId?: string; agentId?: string };
    if (
      parsed.userId !== undefined &&
      userId !== undefined &&
      parsed.userId !== userId
    )
      return '';
    return parsed.agentId || '';
  } catch {
    return '';
  }
}
function persistAgentScope(agentId: string, userId?: string) {
  try {
    const payload = { userId: userId ?? null, agentId };
    if (agentId)
      window.localStorage.setItem(
        AGENT_SCOPE_STORAGE_KEY,
        JSON.stringify(payload),
      );
    else window.localStorage.removeItem(AGENT_SCOPE_STORAGE_KEY);
  } catch {}
}
function clearAgentScope(userId?: string) {
  try {
    if (userId !== undefined) {
      const stored = window.localStorage.getItem(AGENT_SCOPE_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as { userId?: string };
        if (parsed.userId === userId)
          window.localStorage.removeItem(AGENT_SCOPE_STORAGE_KEY);
      }
    } else {
      window.localStorage.removeItem(AGENT_SCOPE_STORAGE_KEY);
    }
  } catch {}
}
function emitAgentScope(agentId: string) {
  try {
    window.dispatchEvent(
      new CustomEvent(AGENT_SCOPE_EVENT, { detail: { agentId } }),
    );
  } catch {}
}

// ---- API helpers -----------------------------------------------------------

/** Strip PilotDeck-only fields that the module gateway would reject. */
function cleanKnowledgeCreateBody(body?: Record<string, unknown>): Record<string, unknown> {
  if (!body) return {};
  const cleaned = { ...body };
  for (const key of ['tenant_id', 'agent_id']) delete cleaned[key];
  return cleaned;
}
function cleanKnowledgeImportBody(body?: Record<string, unknown>): Record<string, unknown> {
  if (!body) return {};
  const cleaned = { ...body };
  // `capability_scope` is a StaffDeck enterprise field: knowledge-core's
  // document import validates its body strictly and rejects it as unknown.
  for (const key of ['tenant_id', 'agent_id', 'capability_scope']) delete cleaned[key];
  return cleaned;
}

/**
 * The vendored knowledge UI reads `job.id`, `job.status` and a 0..1 `progress`.
 * The StaffDeck ingest API is less consistent (envelopes, job_id/jobId, 0..100),
 * so normalise every job the page can receive: upload, single poll and list.
 */
function normalizeKnowledgeJob(job: unknown): unknown {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return job;
  let record = job as Record<string, unknown>;

  // Unwrap the common envelopes when there is no job payload at the top level.
  const hasJobFields = () =>
    ['id', 'job_id', 'jobId', 'status'].some((key) => record[key] !== undefined);
  for (const key of ['result', 'data', 'job']) {
    const inner = record[key];
    if (!hasJobFields() && inner && typeof inner === 'object' && !Array.isArray(inner)) {
      record = inner as Record<string, unknown>;
    }
  }

  const rawId = record.id ?? record.job_id ?? record.jobId;
  const normalized: Record<string, unknown> = { ...record };
  if (typeof rawId === 'string' && rawId) normalized.id = rawId;
  if (typeof normalized.status === 'string') normalized.status = normalized.status.toLowerCase();
  if (typeof normalized.progress === 'number' && normalized.progress > 1) {
    // Backends report 0..100; the progress bar expects 0..1.
    normalized.progress = Math.min(1, normalized.progress / 100);
  }
  return normalized;
}

/** Collections may arrive as `{data: [...]}` / `{result: [...]}` / a bare array. */
function normalizeKnowledgeCollection(rows: unknown): unknown[] {
  if (Array.isArray(rows)) return rows.map((item) => normalizeKnowledgeJob(item));
  if (rows && typeof rows === 'object') {
    for (const key of ['data', 'items', 'result', 'jobs']) {
      const inner = (rows as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner.map((item) => normalizeKnowledgeJob(item));
    }
  }
  return [];
}

/**
 * knowledge-core deployments with the catalog module enabled require an
 * existing knowledge base for document imports; the minimal preset imports
 * documents straight into the service. Detect that one case so upload-auto can
 * create a base and retry exactly once.
 */
function needsKnowledgeBase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /knowledge_base_id/i.test(message);
}

// Minimal knowledge-core deployments disable the catalog module: documents are
// service-global and there is no knowledge_bases table. The shared page lists
// knowledge bases and groups documents by `knowledge_base_id`, so present each
// imported document as its own base (this mirrors upload-auto creating a base
// per file on StaffDeck).
/** Map knowledge-core documents to the page's document rows. */
function localDocumentRows(rows: unknown): Record<string, unknown>[] {
  return (normalizeKnowledgeCollection(rows) as Record<string, unknown>[]).map((doc) => {
    const next: Record<string, unknown> = { ...doc };
    // The service duplicates the body in `content` and `metadata.raw_text`;
    // keep the metadata copy (used by the editor) and drop the duplicate.
    delete next.content;
    if (!next.knowledge_base_id && typeof next.id === 'string') next.knowledge_base_id = next.id;
    if (typeof next.status === 'string') next.status = next.status.toLowerCase();
    return next;
  });
}

/** Derive one knowledge base row per service document. */
function localKnowledgeBases(documents: Record<string, unknown>[]): Record<string, unknown>[] {
  return documents
    .filter((doc) => typeof doc.id === 'string')
    .map((doc) => ({
      id: doc.id,
      name: String(doc.title || doc.filename || doc.id),
      description: typeof doc.filename === 'string' ? doc.filename : '',
      status: 'active',
      capability_scope: 'general',
      document_count: 1,
      bucket_count: typeof doc.bucket_count === 'number' ? doc.bucket_count : 0,
      chunk_count: typeof doc.chunk_count === 'number' ? doc.chunk_count : 0,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      metadata: { knowledge_core: true, source_document_id: doc.id },
    }));
}

/**
 * `list_documents` returns every document with its full text (several MB), and
 * the page asks for it twice on mount (bases panel + documents panel). Share
 * one in-flight response for a short window so a single refresh costs one call.
 */
const LOCAL_DOCUMENTS_TTL_MS = 1000;
let localDocumentsCall: { at: number; promise: Promise<unknown> } | null = null;

function listLocalDocuments(options?: ModuleRequestOptions): Promise<unknown> {
  const now = Date.now();
  if (localDocumentsCall && now - localDocumentsCall.at < LOCAL_DOCUMENTS_TTL_MS) {
    return localDocumentsCall.promise;
  }
  const promise = staffDeckKnowledgeClient.call<unknown>('list_documents', {}, options);
  localDocumentsCall = { at: now, promise };
  promise.catch(() => {
    localDocumentsCall = null;
  });
  return promise;
}

async function callKnowledgeApi<T>(
  path: string,
  method: 'get' | 'post' | 'put' | 'delete',
  body?: unknown,
  options?: ModuleRequestOptions,
  context?: CopyContext,
): Promise<T> {
  options?.signal?.throwIfAborted();
  const url = new URL(path, 'http://staffdeck.local');

  // Page routes below are served by knowledge-core/v1 through the module
  // gateway (`POST /api/modules/knowledge/call`). The remote StaffDeck public
  // SDK is not bridged in PilotDeck, so routing them there only ever produced
  // `{result: null}` calls and a missing multipart transport.
  const knowledgeCall = (
    operation: string,
    input: Record<string, unknown> = {},
  ): Promise<unknown> =>
    staffDeckKnowledgeClient.call<unknown>(operation, input, options);

  // Public host routes already wired in PilotDeck module gateway.
  const publicPlan = planPublicHost(path, method, body);
  if (publicPlan) {
    const scope = context
      ? selectedPublicScope(
          path,
          body as Record<string, unknown>,
          context.readScope,
        )
      : undefined;
    return (await callPublicHost(
      publicPlan,
      scope as any,
      options?.signal,
    )) as T;
  }

  // agents directory → copy context (same as skills adapter).
  if (url.pathname === '/api/enterprise/agents' && method === 'get') {
    return (await (context ?? createFixedTargetContext()).loadDirectory(
      options,
    )) as any;
  }

  // knowledge-bases → derive one row per service document. The minimal preset
  // disables the catalog module, so `list_bases` / `get_base` answer 501 and
  // every 5xx also raises a global error toast; reading the document list
  // instead keeps the plaza working without spurious errors.
  const basesMatch = url.pathname.match(
    /^\/api\/enterprise\/knowledge-bases(?:\/([^/]+))?$/,
  );
  if (basesMatch && method === 'get') {
    const baseId = basesMatch[1] ? decodeURIComponent(basesMatch[1]) : '';
    const bases = localKnowledgeBases(localDocumentRows(await listLocalDocuments(options)));
    if (baseId) return (bases.find((base) => base.id === baseId) || {}) as T;
    return bases as T;
  }

  // GET /api/enterprise/knowledge/documents → knowledge-core documents
  if (url.pathname === '/api/enterprise/knowledge/documents' && method === 'get') {
    return localDocumentRows(await listLocalDocuments(options)) as T;
  }

  // import resources → copy client (same as skills adapter)
  const importMatch = path.match(
    /^\/api\/enterprise\/agents\/([^/?]+)\/resources\/import$/,
  );
  if (importMatch && method === 'post') {
    return await staffDeckCopyClient.call<T>('import_resources', {
      targetAgentId: decodeURIComponent(importMatch[1]),
      sourceAgentId: body ? (body as any).source_agent_id : undefined,
      resourceType: body ? (body as any).resource_type : undefined,
      resourceIds: body ? (body as any).resource_ids : undefined,
    });
  }

  // ---- Knowledge page actions → PilotDeck local knowledge module ----------

  // POST /api/enterprise/knowledge-bases → create_base
  if (basesMatch && method === 'post') {
    const input = cleanKnowledgeCreateBody(body as Record<string, unknown> | undefined);
    return (await knowledgeCall('create_base', input)) as T;
  }

  // POST /api/enterprise/knowledge/documents/upload-auto → import_document
  // NOTE: must be checked BEFORE the generic /documents route below — the
  // upload-auto path would otherwise be swallowed by it. The minimal
  // knowledge-core preset imports straight into the service; deployments with
  // the catalog module enabled need a base first, so retry once after creating.
  if (url.pathname === '/api/enterprise/knowledge/documents/upload-auto' && method === 'post') {
    const bodyObj = body as Record<string, unknown> | undefined;
    const input = cleanKnowledgeImportBody(bodyObj);
    let baseId = String(bodyObj?.knowledge_base_id ?? bodyObj?.knowledgeBaseId ?? '');
    if (baseId) input.knowledge_base_id = baseId;
    let job: unknown;
    try {
      job = await knowledgeCall('import_document', input);
    } catch (error) {
      if (!needsKnowledgeBase(error)) throw error;
      const created = (await knowledgeCall('create_base', {
        name: String(bodyObj?.title || bodyObj?.filename || '新建知识库'),
        capability_scope: bodyObj?.capability_scope,
      })) as Record<string, unknown> | undefined;
      baseId = String(created?.id ?? created?.knowledge_base_id ?? '');
      job = await knowledgeCall('import_document', {
        ...input,
        knowledge_base_id: baseId,
      });
    }
    const normalized = normalizeKnowledgeJob(job) as Record<string, unknown>;
    if (baseId && normalized && typeof normalized === 'object' && !normalized.knowledge_base_id) {
      normalized.knowledge_base_id = baseId;
    }
    return normalized as T;
  }

  // POST /api/enterprise/knowledge/documents → import_document
  const documentsMatch = url.pathname.match(
    /^\/api\/enterprise\/knowledge\/documents$/,
  );
  if (documentsMatch && method === 'post') {
    const bodyObj = body as Record<string, unknown> | undefined;
    const input = cleanKnowledgeImportBody(bodyObj);
    const knowledgeBaseId = String(bodyObj?.knowledge_base_id ?? bodyObj?.knowledgeBaseId ?? '');
    if (knowledgeBaseId) input.knowledge_base_id = knowledgeBaseId;
    return normalizeKnowledgeJob(await knowledgeCall('import_document', input)) as T;
  }

  // POST /api/enterprise/knowledge/search → knowledge-core query
  // The page's progressive-retrieval panel runs on the same `query` operation.
  // This knowledge-core build validates its body strictly: StaffDeck's
  // identity fields (tenant_id/agent_id), the debug tuning flags (mode,
  // max_depth, need_evidence_pack, max_buckets, query_type, desired_evidence,
  // scope, max_bucket_rounds, budget_tokens) and knowledge_base_ids (catalog
  // module disabled in the minimal preset) are rejected as unknown fields, and
  // a PilotDeck catalog model id is rejected as "Unknown model_id". Query still
  // returns route_trace, selected_concepts, selected_documents,
  // expanded_sections and evidence_pack, so the panel renders in full.
  if (url.pathname === '/api/enterprise/knowledge/search' && method === 'post') {
    const bodyObj = (body as Record<string, unknown> | undefined) ?? {};
    const input: Record<string, unknown> = {};
    for (const key of ['query', 'use_model', 'max_chunks', 'document_ids']) {
      if (bodyObj[key] !== undefined) input[key] = bodyObj[key];
    }
    return (await knowledgeCall('query', input)) as T;
  }

  // GET /api/enterprise/knowledge/jobs(/:id) → list_jobs / get_job
  const jobsGet = url.pathname.match(
    /^\/api\/enterprise\/knowledge\/jobs(?:\/([^/]+))?$/,
  );
  if (jobsGet && method === 'get') {
    if (jobsGet[1]) {
      return normalizeKnowledgeJob(await knowledgeCall('get_job', { jobId: jobsGet[1] })) as T;
    }
    return normalizeKnowledgeCollection(await knowledgeCall('list_jobs', {})) as T;
  }

  // POST /api/enterprise/knowledge/okf/import → import_okf
  const okfImportMatch = url.pathname.match(/^\/api\/enterprise\/knowledge\/okf\/import$/);
  if (okfImportMatch && method === 'post') {
    const bodyObj = body as Record<string, unknown> | undefined;
    const input = cleanKnowledgeImportBody(bodyObj);
    // OKF bundles are self-contained; the catalog preset can target an
    // existing base but the minimal preset has no catalog, so drop the id
    // here — the backend's import_okf route accepts bare bodies.
    delete input.knowledge_base_id;
    delete input.knowledgeBaseId;
    return (await knowledgeCall('import_okf', input)) as T;
  }

  // DELETE /api/enterprise/knowledge-bases/:id → delete_base
  const basesDelete = url.pathname.match(/^\/api\/enterprise\/knowledge-bases\/([^/]+)$/);
  if (basesDelete && method === 'delete') {
    return (await knowledgeCall('delete_base', { knowledgeBaseId: basesDelete[1] })) as T;
  }

  // POST /api/enterprise/knowledge-bases/:id/rollback → rollback_version
  const rollbackMatch = url.pathname.match(/^\/api\/enterprise\/knowledge-bases\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'post') {
    const input = (body as Record<string, unknown> | undefined) ?? {};
    return (await knowledgeCall('rollback_version', {
      knowledgeBaseId: rollbackMatch[1],
      versionId: input.version_id ?? input.version,
      expected_updated_at: input.expected_updated_at ?? input.expectedUpdatedAt,
    })) as T;
  }

  // POST /api/enterprise/knowledge/discoveries/:id/confirm|reject
  const discoveryMatch = url.pathname.match(/^\/api\/enterprise\/knowledge\/discoveries\/([^/]+)\/(confirm|reject)$/);
  if (discoveryMatch && method === 'post') {
    const op = discoveryMatch[2] === 'confirm' ? 'confirm_discovery' : 'reject_discovery';
    return (await knowledgeCall(op, { suggestionId: discoveryMatch[1] })) as T;
  }

  // POST /api/enterprise/knowledge-bases/:id/:overall-action (sync-from-overall, promote-to-overall)
  // knowledge-core has no equivalent operation — fall through to the catch-all.

  // model-configs → public module client (staffdeck adapter already maps this
  // but KnowledgePage uses the direct /api/enterprise/model-configs form).
  if (url.pathname === '/api/enterprise/model-configs' && method === 'get') {
    const scope = context
      ? selectedPublicScope(path, {}, context.readScope)
      : undefined;
    const rows = (await callPublicHost(
      {
        operation: 'list_staffdeck_model_catalog',
        input: {},
        collection: true,
      },
      scope as any,
      options?.signal,
    )) as any[];
    return rows as T;
  }

  // GET /api/enterprise/knowledge-bases/:id/okf/concepts → the local
  // knowledge-core build has no OKF concept store; answer with an empty list.
  if (
    /^\/api\/enterprise\/knowledge-bases\/[^/]+\/okf\/concepts$/.test(url.pathname) &&
    method === 'get'
  ) {
    return [] as unknown as T;
  }

  // GET /api/enterprise/knowledge/documents/:id/buckets → the running
  // knowledge-core build does not expose per-document buckets; answer with an
  // empty collection so the page renders its empty state instead of an error.
  if (
    /^\/api\/enterprise\/knowledge\/documents\/[^/]+\/buckets$/.test(url.pathname) &&
    method === 'get'
  ) {
    return [] as unknown as T;
  }

  // Everything else — enterprise knowledge collection/detail routes that
  // the PilotDeck gateway doesn't expose. Synthesize well-shaped empty
  // responses for GETs (collections → [], single-resource → {}) so the page
  // renders cleanly with empty state. Write operations still throw so the
  // in-page alert fires if the user tries to mutate data.
  if (
    url.pathname.startsWith('/api/enterprise/knowledge/') &&
    method === 'get'
  ) {
    // Collection routes → []
    const collectionSuffixes = [
      /^\/api\/enterprise\/knowledge\/documents$/,
      /^\/api\/enterprise\/knowledge\/jobs$/,
      /^\/api\/enterprise\/knowledge\/discoveries$/,
      /^\/api\/enterprise\/knowledge\/buckets\/[^/]+\/chunks$/,
    ];
    for (const re of collectionSuffixes) {
      if (re.test(url.pathname)) return [] as unknown as T;
    }
    // Single-resource routes → {} (jobs/{id} polling, documents/{id}, etc.)
    if (/^\/api\/enterprise\/knowledge\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return {} as unknown as T;
    }
  }

  throw new Error(
    `StaffDeck knowledge route is not mapped: ${method.toUpperCase()} ${url.pathname}`,
  );
}

async function callKnowledgeBlob(path: string): Promise<Blob> {
  const response = await authenticatedFetch(path);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = (() => {
      try {
        return JSON.parse(body)?.detail ?? body;
      } catch {
        return body;
      }
    })();
    throw new Error(
      typeof detail === 'string' ? detail : `HTTP ${response.status}`,
    );
  }
  return await response.blob();
}

// ---- Host factory ----------------------------------------------------------

function createPilotDeckKnowledgePageHost(
  context?: CopyContext,
): KnowledgePageHost {
  return {
    icons: pilotDeckFormalIcons,
    components: {
      ...pilotDeckFormalComponents,
      // KnowledgeGraphVisualization is a passthrough on the StaffDeck side;
      // PilotDeck doesn't ship the canvas component so surface a minimal
      // placeholder that lets the page mount while the canvas isn't wired up.
      KnowledgeGraphVisualization: ({ document, knowledgeBase }: any) => {
        return React.createElement(
          'div',
          {
            className:
              'rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500',
          },
          '知识图谱可视化未配置',
        );
      },
    },
    api: {
      get: (path) =>
        callKnowledgeApi(path, 'get', undefined, undefined, context),
      post: (path, body) =>
        callKnowledgeApi(path, 'post', body, undefined, context),
      put: (path, body) =>
        callKnowledgeApi(path, 'put', body, undefined, context),
      delete: (path) =>
        callKnowledgeApi(path, 'delete', undefined, undefined, context),
      blob: (path) => callKnowledgeBlob(path),
    },
    navigate: (path: string) => {
      // KnowledgePage uses /enterprise/knowledge/... paths; remap to /knowledge/...
      window.history.pushState(
        {},
        '',
        path.replace(/^\/enterprise\/knowledge/, '/knowledge'),
      );
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    tenantId: PILOTDECK_KNOWLEDGE_TENANT_ID,
    notify: staffDeckNotify,
    isEnterpriseAdmin: (user) => Boolean(user?.is_admin),
    loadEmployeeDirectory: () =>
      (context ?? createFixedTargetContext()).loadDirectory() as any,
    agentScope: {
      read: () => readPersistedAgentScope(),
      persist: (agentId, userId) => persistAgentScope(agentId, userId),
      clear: (userId) => clearAgentScope(userId),
      emit: (agentId) => emitAgentScope(agentId),
    },
    visibleEmployeeAgents: (agents, _user, options = {}) =>
      agents.filter(
        (agent: any) =>
          !agent.is_overall &&
          (!options.activeOnly || agent.active !== false) &&
          agent.id !== options.excludeAgentId,
      ),
    // PilotDeck is a single-user host: the local operator owns every agent.
    canManageEmployeeAgent: () => true,
    openGalleryAgentId: (agents) =>
      (agents as any[]).find((a) => a.is_overall)?.id || '',
    openGalleryImportSourceOptions: (agents) =>
      (agents as any[])
        .filter((a) => a.is_overall)
        .map((a) => ({ value: a.id, label: a.name || a.id })),
    resourceCreatorName: (row: any) =>
      String(row.created_by_name || row.creator_name || ''),
    renderMarkdownBlocks: (value: string) =>
      React.createElement('span', null, value),
    getDateLocale: () => 'zh-CN',
  } as KnowledgePageHost;
}

// ---- Provider --------------------------------------------------------------

export function PilotDeckKnowledgePageProvider({
  children,
}: {
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const hostCapabilities = usePilotDeckHostCapabilities();
  const context = React.useMemo(
    () => createFixedTargetContext(hostCapabilities),
    [hostCapabilities],
  );
  const host = React.useMemo(
    () => createPilotDeckKnowledgePageHost(context),
    [context],
  );

  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void context
      .loadDirectory({ signal: controller.signal })
      .then(() => {
        if (mounted) setReady(true);
      })
      .catch((cause) => {
        if (mounted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [context]);

  if (error) return React.createElement('div', { role: 'alert' }, error);
  if (!ready) return null;

  // Inject a real navigate so StaffDeck's route-to-host redirects land on
  // /knowledge instead of /enterprise/knowledge.
  const finalHost = {
    ...host,
    tenantId: context.readTenant(),
    navigate: (path: string, options?: any) =>
      navigate(path.replace(/^\/enterprise\/knowledge/, '/knowledge'), options),
  };
  return React.createElement(
    KnowledgePageHostProvider,
    { value: finalHost },
    children,
  );
}
