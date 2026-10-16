import { usePilotDeckHostCapabilities } from '../pilotdeck-host-capabilities';
import { planPublicHost, callPublicHost, selectedPublicScope, publicModuleClient, previewEvents } from '../public-host-mapping';
import type { SkillsPageHost } from './SkillsPageHost';
import { SkillsPageHostProvider } from './SkillsPageHost';
import { PilotDeckDataTable, PilotDeckResourceImportDialog } from './business-primitives';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from './dialog-primitives';
import { pilotDeckFormalComponents, pilotDeckFormalIcons } from './host-components';
import type { DistillPageHost } from './DistillPageHost';
import { DistillPageHostProvider } from './DistillPageHost';
import * as React from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { staffDeckCopyClient, staffDeckKnowledgeClient, staffDeckSopManagementClient, type SopDefinition, type ModuleRequestOptions } from '../clients';
import { staffDeckNotify } from '../host-notify';
import { usePublishRuntimeObserver } from '../publish-runtime-context';
import type { PublishRuntimeObserver } from '../publish-runtime-observer';
import { isTeamScope } from '../host-contract-helpers';
import { createFixedTargetContext, isCopyTarget, loadCopyDirectory, readCopyAgentScope, type CopyContext } from './copy-scope';

// PilotDeck is a single-user host. The SOP management identity is supplied by
// the server-side StaffDeck API-key/agent binding; this value is only the
// local host context required by the source-derived shared page. It must not
// impersonate StaffDeck's example tenant.
export const PILOTDECK_SOP_TENANT_ID = 'pilotdeck-local';

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function record(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }

function toSkill(definition: SopDefinition, status = 'published') {
  if (!text(definition.id)) throw new Error('SOP response has no formal row ID.');
  const content = record(definition.content);
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const nodes = Array.isArray(content.nodes) ? content.nodes : [];
  return {
    ...definition,
    ...content,
    id: definition.id,
    skill_id: text(definition.skill_id) || definition.id,
    name: text(content.name) || text(definition.name) || definition.id,
    version: text(definition.version) || text(content.version),
    description: text(content.description) || text(definition.description) || '',
    business_domain: text(content.business_domain) || text(definition.business_domain) || '',
    status: text(definition.status) || status,
    updated_at: text(definition.updated_at),
    content,
    call_count: Number(definition.call_count) || 0,
    positive_rate: Number(definition.positive_rate) || 0,
    negative_rate: Number(definition.negative_rate) || 0,
    total_call_count: Number(definition.total_call_count) || Number(definition.call_count) || 0,
    total_positive_rate: Number(definition.total_positive_rate) || Number(definition.positive_rate) || 0,
    total_negative_rate: Number(definition.total_negative_rate) || Number(definition.negative_rate) || 0,
    branch_status: text(definition.branch_status),
    draft_id: text(definition.draft_id),
    etag: text(definition.etag),
    trigger_intents: list(content.trigger_intents),
    user_utterance_examples: list(content.user_utterance_examples),
    goal: list(content.goal),
    required_info: list(content.required_info),
    response_rules: list(content.response_rules),
    nodes,
    terminal_node_ids: list(content.terminal_node_ids),
  };
}

function toManagedSkill(row: unknown) {
  const draft = record(row);
  const skillId = text(draft.sop_id) || text(draft.skill_id) || text(draft.id);
  if (!skillId) throw new Error('SOP response has no formal SOP ID.');
  const rowId = text(draft.id);
  if (!rowId) throw new Error('SOP response has no formal row ID.');
  const isDraft = Boolean(text(draft.sop_id) || text(draft.draft_id));
  return toSkill({
    ...draft,
    id: rowId,
    skill_id: skillId,
    draft_id: isDraft ? text(draft.draft_id) || text(draft.id) : undefined,
    version: text(draft.draft_version) || text(draft.version),
    content: record(draft.content),
  } as SopDefinition, text(draft.status) || (isDraft ? 'draft' : 'published'));
}

function selectedDraft(row: unknown, sopId: string, draftId?: string) {
  const projected = toManagedSkill(row);
  if (projected.skill_id !== sopId || !text(projected.draft_id) || (draftId && projected.draft_id !== draftId)) {
    throw new Error('SOP draft response does not match the selected lifecycle.');
  }
  return projected;
}

async function management(operation: string, input: Record<string, unknown> = {}, options?: ModuleRequestOptions): Promise<any> {
  return options ? staffDeckSopManagementClient.call(operation, input, options) : staffDeckSopManagementClient.call(operation, input);
}

async function listDefinitions(options?: ModuleRequestOptions, scope?: ReturnType<typeof selectedPublicScope>): Promise<any[]> {
  const result = record(scope ? (await publicModuleClient.call('list_sops', {}, { scope, signal: options?.signal })).body : await management('list', {}, options));
  if (!Array.isArray(result.data) || !Array.isArray(result.drafts)) throw new Error('SOP list response must include data and drafts arrays.');
  const published = result.data.map(toManagedSkill);
  const drafts: ReturnType<typeof toManagedSkill>[] = [];
  for (const row of result.drafts) {
    if (record(row).status !== 'draft') continue;
    drafts.push(toManagedSkill(row));
  }
  const ids = new Set<string>();
  for (const row of [...published, ...drafts]) {
    if (ids.has(row.id)) throw new Error('SOP list returned duplicate formal row IDs.');
    ids.add(row.id);
  }
  // Each draft has a distinct owner row ID and editor_context. Preserve every
  // choice; no response ordering or timestamp is used to pick an unseen draft.
  const draftsBySop = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const group = draftsBySop.get(draft.skill_id) || [];
    group.push(draft);
    draftsBySop.set(draft.skill_id, group);
  }
  const rows: typeof drafts = [];
  for (const row of published) {
    const choices = draftsBySop.get(row.skill_id);
    if (choices) {
      rows.push(...choices);
      draftsBySop.delete(row.skill_id);
    } else rows.push(row);
  }
  for (const choices of draftsBySop.values()) rows.push(...choices);
  return rows;
}

async function requireManagementScope(path: string, body: unknown, context?: CopyContext, options?: ModuleRequestOptions) {
  if (!context && !new URL(path, 'http://host.local').searchParams.has('agent_id')) return;
  const scope = selectedPublicScope(path, body as Record<string, unknown>, context?.readScope);
  const status = await staffDeckSopManagementClient.status(options);
  if (scope.kind !== 'agent' || scope.agentId !== status.agentId) throw new Error('PUBLIC_SCOPED_MANAGEMENT_UNAVAILABLE: this draft/version management operation has no equivalent selected-scope contract.');
}

async function callSkillApi<T>(path: string, method: 'get' | 'post' | 'put' | 'delete', body?: any, options?: ModuleRequestOptions, context?: CopyContext): Promise<T> {
  options?.signal?.throwIfAborted();
  const sourcePath = new URL(path, 'http://staffdeck.local').pathname.match(/^\/api\/enterprise\/agents\/([^/]+)\/skills$/);
  if (method === 'get' && sourcePath) {
    return await staffDeckCopyClient.call<T>('list_skills', { sourceAgentId: decodeURIComponent(sourcePath[1]) }, options);
  }
  context?.assertSelectedScope(selectedPublicScope(path, body, context.readScope));
  const publicPlan = planPublicHost(path, method, body);
  if (publicPlan) return await callPublicHost(publicPlan, selectedPublicScope(path, body, context?.readScope), options?.signal, context?.hostCapabilities) as T;
  const url = new URL(path, 'http://staffdeck.local');
  const match = path.split('?')[0].match(/^\/api\/enterprise\/skills\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
  const importMatch = path.match(/^\/api\/enterprise\/agents\/([^/?]+)\/resources\/import$/);
  if (importMatch && method === 'post') return await staffDeckCopyClient.call<T>('import_resources', {
    targetAgentId: decodeURIComponent(importMatch[1]), sourceAgentId: body?.source_agent_id,
    resourceType: body?.resource_type, resourceIds: body?.resource_ids,
  });
  if (url.pathname === '/api/enterprise/skills') {
    if (method === 'get') return await listDefinitions(options, url.searchParams.has('agent_id') || context ? selectedPublicScope(path, body, context?.readScope) : undefined) as T;
    if (method === 'post') {
      await requireManagementScope(path, body, context, options);
      return toManagedSkill(await management('create', { content: record(body?.content ?? body) }, options)) as T;
    }
  }
  if (url.pathname === '/api/enterprise/agents' && method === 'get') return await (context ? context.loadDirectory(options) : loadCopyDirectory(options)) as T;
  if (/^\/api\/enterprise\/agents\/[^/]+\/skills$/.test(url.pathname)) {
    if (method !== 'get') throw new Error(`Unsupported StaffDeck skills operation: ${method} ${path}`);
    const sourceAgentId = decodeURIComponent(path.split('/')[4]);
    return await staffDeckCopyClient.call<T>('list_skills', { sourceAgentId });
  }
  if (!match) throw new Error(`Unsupported StaffDeck skills path: ${path}`);
  await requireManagementScope(path, body, context, options);
  const sopId = decodeURIComponent(match[1]);
  const suffix = match[2] ? decodeURIComponent(match[2]) : '';
  const version = match[3] ? decodeURIComponent(match[3]) : undefined;
  const action = match[4];
  if (method === 'get' && suffix === 'versions' && version && !action) {
    const result = await management('get_version', { sopId, version }, options);
    if (!result || Array.isArray(result) || typeof result.updated_at !== 'string') {
      throw new Error('SOP version detail response is missing its formal updated_at field.');
    }
    return result as T;
  }
  if (method === 'post' && suffix === 'versions' && version && action === 'rollback') {
    return toManagedSkill(await management('rollback', { sopId, version }, options)) as T;
  }
  if (version || action) throw new Error(`Unsupported StaffDeck skills operation: ${method} ${path}`);
  if (method === 'get' && suffix === 'versions') {
    const result = record(await management('list_versions', { sopId }, options));
    if (!Array.isArray(result.data)) throw new Error('SOP version list response must include a data array.');
    return result.data as T;
  }
  if (method === 'post' && suffix === 'publish') {
    const query = new URLSearchParams(path.split('?')[1] || '');
    const draftId = text(query.get('draft_id'));
    const current = await readDefinition(sopId, draftId, undefined, options?.signal ? { signal: options.signal } : undefined);
    if (!text(current.draft_id)) throw new Error('SOP publish requires a selected draft.');
    return await management('publish', { sopId, draftId: current.draft_id }, options) as T;
  }
  if (method === 'post' && suffix === 'archive') return await management('archive', { sopId }, options) as T;
  if (method === 'post' && suffix === 'draft') throw new Error('Move to draft requires an equivalent public management capability; creating another draft is not equivalent.');
  if (method === 'post' && suffix === 'rollback') return await management('rollback', { sopId, version: body?.version }, options) as T;
  if (method === 'delete' && !suffix) throw new Error('Remove requires an equivalent public management capability; archiving is not equivalent.');
  throw new Error(`Unsupported StaffDeck skills operation: ${method} ${path}`);
}

function skillIdFromPath(path: string): string | undefined {
  const match = new URL(path, 'http://staffdeck.local').pathname.match(/^\/api\/enterprise\/skills\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function readDefinition(skillId: string, draftId?: string, publishedVersion?: string, options?: ModuleRequestOptions): Promise<any> {
  if (draftId) return selectedDraft(await management('get_draft', { sopId: skillId, draftId }, options), skillId, draftId);
  if (publishedVersion) return toSkill(await management('get_version', { sopId: skillId, version: publishedVersion }, options));
  const managed = await listDefinitions(options);
  const matching = managed.filter((item) => item.skill_id === skillId);
  if (matching.length > 1) throw new Error('Multiple SOP drafts require an explicit draft_id selection.');
  const managedDefinition = matching[0];
  if (!managedDefinition) throw new Error(`SOP definition not found in the configured management owner: ${skillId}`);
  if (!text(managedDefinition.draft_id)) return managedDefinition;
  const draft = await management('get_draft', { sopId: skillId, draftId: managedDefinition.draft_id }, options);
  return selectedDraft(draft, skillId, managedDefinition.draft_id);
}

const SOP_CONTENT_FIELDS = new Set([
  'skill_id', 'name', 'version', 'business_domain', 'description', 'capability_scope',
  'step_timeout_seconds', 'trigger_intents', 'user_utterance_examples', 'goal',
  'required_info', 'slot_filling_policy', 'response_rules', 'nodes', 'edges',
  'start_node_id', 'terminal_node_ids', 'interruption_policy',
]);

function skillContent(current: Record<string, any>, body: unknown) {
  const next = { ...record(current.content) };
  const candidate = record(body);
  for (const field of SOP_CONTENT_FIELDS) {
    if (candidate[field] !== undefined) next[field] = candidate[field];
  }
  return { ...next, ...record(candidate.content) };
}

function queryPathIsSkill(path: string): boolean {
  return /^\/api\/enterprise\/skills\/[^/]+$/.test(path.split('?')[0]);
}

async function callDistillApi<T>(snapshots: Map<string, any>, path: string, method: 'get' | 'post' | 'put' | 'delete', body?: any, options?: ModuleRequestOptions, context?: CopyContext): Promise<T> {
  options?.signal?.throwIfAborted();
  const sourcePath = new URL(path, 'http://staffdeck.local').pathname.match(/^\/api\/enterprise\/agents\/([^/]+)\/skills$/);
  if (method === 'get' && sourcePath) {
    return await staffDeckCopyClient.call<T>('list_skills', { sourceAgentId: decodeURIComponent(sourcePath[1]) }, options);
  }
  context?.assertSelectedScope(selectedPublicScope(path, body, context.readScope));
  const publicPlan = planPublicHost(path, method, body);
  if (publicPlan) return await callPublicHost(publicPlan, selectedPublicScope(path, body, context?.readScope), options?.signal, context?.hostCapabilities) as T;
  if (path.startsWith('/api/enterprise/tools')) throw new Error('PilotDeck tools capability is unavailable in this host.');
  if (path.startsWith('/api/enterprise/general-skills')) throw new Error('PilotDeck general-skills capability is unavailable in this host.');
  if (path.startsWith('/api/enterprise/model-configs')) throw new Error('PilotDeck model-configs capability is unavailable in this host.');
  if (path.startsWith('/api/auth/users')) throw new Error('PilotDeck user-directory capability is unavailable in this host.');
  if (path.split('?')[0] === '/api/enterprise/knowledge-bases' && method === 'get') {
    const query = new URLSearchParams(path.split('?')[1] || '');
    const input: Record<string, unknown> = {};
    if (query.get('agent_id')) input.agentId = query.get('agent_id');
    if (query.get('tenant_id')) input.tenantId = query.get('tenant_id');
    if (context || query.has('agent_id')) return await callPublicHost({ operation: 'list_knowledge_bases', input: {}, collection: true }, selectedPublicScope(path, body, context?.readScope), options?.signal, context?.hostCapabilities) as T;
    return await staffDeckKnowledgeClient.call<T>('list_bases', input, options);
  }
  if (path.split('?')[0] === '/api/enterprise/skills') {
    if (method === 'get') return await listDefinitions(options, new URL(path, 'http://host.local').searchParams.has('agent_id') || context ? selectedPublicScope(path, body, context?.readScope) : undefined) as T;
    if (method === 'post') {
      await requireManagementScope(path, body, context, options);
      const created = toManagedSkill(await management('create', { content: record(body?.content ?? body) }, options));
      if (!text(created.draft_id)) throw new Error('SOP create response has no draft ID.');
      options?.signal?.throwIfAborted();
      snapshots.set(created.skill_id, structuredClone(created));
      return created as T;
    }
  }
  const skillId = skillIdFromPath(path);
  if (skillId) await requireManagementScope(path, body, context, options);
  if (skillId && method === 'get' && queryPathIsSkill(path)) {
    const query = new URLSearchParams(path.split('?')[1] || '');
    const loaded = await readDefinition(skillId, text(query.get('draft_id')), text(query.get('published_version')), options);
    options?.signal?.throwIfAborted();
    snapshots.set(skillId, structuredClone(loaded));
    return loaded as T;
  }
  if (skillId && method === 'put' && queryPathIsSkill(path)) {
    const current = snapshots.get(skillId);
    if (!current) throw new Error('SOP edit snapshot is unavailable. Reload the editor before saving.');
    const content = skillContent(current, body);
    if (text(current.draft_id) && !text(current.etag)) throw new Error('SOP edit snapshot has no ETag. Reload the editor before saving.');
    if (text(current.draft_id) && text(current.etag)) {
        const saved = await management('replace_draft', {
          sopId: skillId,
          draftId: current.draft_id,
          etag: current.etag,
          content,
        }, options);
        const next = selectedDraft(saved, skillId, current.draft_id);
        snapshots.set(skillId, structuredClone(next));
        return next as T;
    }
    // A published management row may not have a draft yet. Create it with
    // the same owner; lack of management must remain an explicit failure.
    const saved = await management('create', { sopId: skillId, content, baseVersion: current.version }, options);
    const next = selectedDraft(saved, skillId);
    snapshots.set(skillId, structuredClone(next));
    return next as T;
  }
  if (method === 'post' && path.startsWith('/api/enterprise/skills/jobs/')) throw new Error('SOP generation streaming is unavailable in the portable PilotDeck definition host.');
  return await callSkillApi<T>(path, method, body, options, context);
}

export const pilotDeckSkillsPageHost: SkillsPageHost = {
  icons: pilotDeckFormalIcons,
  editorQuery: (row): Record<string, string> => text(row.draft_id)
    ? { editor_context: `draft:${row.draft_id}`, draft_id: row.draft_id }
    : { editor_context: `published:${row.version}`, published_version: row.version },
  components: { ...pilotDeckFormalComponents, DataTable: PilotDeckDataTable, ResourceImportDialog: PilotDeckResourceImportDialog },
  api: {
    get: (path) => callSkillApi(path, 'get'),
    post: (path, body) => callSkillApi(path, 'post', body),
    put: (path, body) => callSkillApi(path, 'put', body),
    delete: (path) => callSkillApi(path, 'delete'),
  },
  navigate: (path: string) => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); },
  tenantId: PILOTDECK_SOP_TENANT_ID,
  notify: staffDeckNotify,
  isEnterpriseAdmin: (user) => Boolean(user?.is_admin),
  canManageEmployeeAgent: (agent) => Boolean(isCopyTarget(agent) && agent.can_manage === true),
  openGalleryAgentId: (agents) => agents.find((agent) => agent.is_overall)?.id || '',
  openGalleryImportSourceOptions: (agents) => agents.filter((agent) => agent.is_overall).map((agent) => ({ value: agent.id, label: agent.name || agent.id })),
  resourceCreatorName: (row) => text(row.created_by_name) || '',
  visibleEmployeeAgents: (agents, _user, options = {}) => agents.filter((agent) => !agent.is_overall && (!options.activeOnly || agent.active !== false) && agent.id !== options.excludeAgentId),
  readEmployeeScope: readCopyAgentScope,
  isTeamScope,
  useClientPagination: <T,>(items: T[], pageSize: number, resetKey: unknown) => {
    const [page, setPage] = React.useState(1);
    React.useEffect(() => setPage(1), [resetKey]);
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(page, pageCount);
    return { page: safePage, pageCount, setPage, pagedItems: items.slice((safePage - 1) * pageSize, safePage * pageSize) };
  },
};

function runtimePublishOptions(path: string, observer?: PublishRuntimeObserver, options?: ModuleRequestOptions): ModuleRequestOptions | undefined {
  const match = path.match(/^\/api\/enterprise\/skills\/([^/]+)\/(publish|archive)(?:\?|$)/);
  if (!observer || !match) return options;
  const sopId = decodeURIComponent(match[1]);
  return { ...options, onManagementEnvelope: match[2] === 'archive' ? observer.captureArchive(sopId) : observer.capturePublish(sopId) };
}

function createPilotDeckSkillsPageHost(context: CopyContext, observer?: PublishRuntimeObserver): SkillsPageHost {
  return {
    ...pilotDeckSkillsPageHost,
    api: {
      get: (path) => callSkillApi(path, 'get', undefined, undefined, context),
      post: (path, body) => callSkillApi(path, 'post', body, runtimePublishOptions(path, observer), context),
      put: (path, body) => callSkillApi(path, 'put', body, undefined, context),
      delete: (path) => callSkillApi(path, 'delete', undefined, undefined, context),
    },
    readEmployeeScope: context.readScope,
    canManageEmployeeAgent: (agent) => Boolean(context.isTarget(agent) && agent.can_manage === true),
  };
}

// Translate only the formal SOP routes; retain query/hash verbatim and leave
// unrelated destinations to the router. Both mounted hosts use this boundary.
export function pilotDeckSopDestination(path: string): string {
  return path.replace(/^\/enterprise\/skills(?=\/|\?|#|$)/, '/sop');
}

export function PilotDeckSkillsPageProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const hostCapabilities = usePilotDeckHostCapabilities();
  const context = React.useMemo(() => createFixedTargetContext(hostCapabilities), [hostCapabilities]);
  const observer = usePublishRuntimeObserver();
  const host = React.useMemo(() => createPilotDeckSkillsPageHost(context, observer), [context, observer]);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void context.loadDirectory({ signal: controller.signal })
      .then(() => listDefinitions({ signal: controller.signal }))
      .then(() => { if (mounted) setReady(true); })
      .catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { mounted = false; controller.abort(); };
  }, [context]);
  if (error) return <div role="alert">{error}</div>;
  if (!ready) return null;
  return <SkillsPageHostProvider value={{ ...host, tenantId: context.readTenant(), navigate: (path) => navigate(pilotDeckSopDestination(path)) }}>{children}</SkillsPageHostProvider>;
}

export function createPilotDeckDistillPageHost(context?: CopyContext, observer?: PublishRuntimeObserver): DistillPageHost {
  // One store per mounted editor, never shared across windows or instances.
  const snapshots = new Map<string, any>();
  return {
  components: pilotDeckFormalComponents,
  icons: pilotDeckFormalIcons,
  saveVersionPolicy: (snapshot) => !text(snapshot.draft_id)
    ? { serviceAssigned: true, label: 'Assigned by the service when creating the draft' }
    : undefined,
  restoreEditorReadSnapshot: (snapshot) => {
    if (!text(snapshot.skill_id)) throw new Error('Cached SOP read snapshot has no skill ID.');
    snapshots.set(snapshot.skill_id, structuredClone(snapshot));
  },
  api: {
    get: (path, options) => callDistillApi(snapshots, path, 'get', undefined, options, context),
    post: (path, body) => callDistillApi(snapshots, path, 'post', body, runtimePublishOptions(path, observer), context),
    postWithSignal: (path, body, signal) => callDistillApi(snapshots, path, 'post', body, runtimePublishOptions(path, observer, { signal }), context),
    put: (path, body) => callDistillApi(snapshots, path, 'put', body, undefined, context),
    delete: (path) => callDistillApi(snapshots, path, 'delete', undefined, undefined, context),
  },
  streamGet: async (path, onEvent, signal) => {
    const url = new URL(path, 'http://host.local');
    const match = url.pathname.match(/^\/api\/enterprise\/skills\/jobs\/([^/]+)\/stream$/);
    if (!match) throw new Error('Unsupported preview stream path.');
    const scope = selectedPublicScope(path, undefined, context?.readScope);
    context?.assertSelectedScope(scope);
    await previewEvents(decodeURIComponent(match[1]), scope, url.searchParams.get('after_seq') ?? undefined, onEvent, signal);
  },
  streamPost: async (path, body, onEvent, signal) => {
    const url = new URL(path, 'http://host.local');
    const rewrite = url.pathname.match(/^\/api\/enterprise\/skills\/([^/]+)\/rewrite\/stream$/);
    if (!rewrite && url.pathname !== '/api/enterprise/skills/distill/stream') throw new Error('Unsupported preview request path.');
    const scope = selectedPublicScope(path, body, context?.readScope);
    context?.assertSelectedScope(scope);
    const inputBody = { ...body }; delete inputBody.tenant_id; delete inputBody.agent_id;
    const response = await publicModuleClient.call(rewrite ? 'preview_rewrite_sop' : 'preview_generate_sop', { ...(rewrite ? { sopId: decodeURIComponent(rewrite[1]) } : {}), body: inputBody }, { scope, signal });
    const job = response.body as { job_id?: string };
    if (response.status !== 202 || !job?.job_id) throw new Error('Preview did not return its own 202 job_id.');
    await previewEvents(job.job_id, scope, undefined, onEvent, signal);
  },
  navigate: (path) => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); },
  tenantId: PILOTDECK_SOP_TENANT_ID,
  notify: staffDeckNotify,
  readEmployeeScope: context ? context.readScope : readCopyAgentScope,
  isTeamScope,
  };
}

export const pilotDeckDistillPageHost = createPilotDeckDistillPageHost();

export function PilotDeckDistillPageProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const hostCapabilities = usePilotDeckHostCapabilities();
  const context = React.useMemo(() => createFixedTargetContext(hostCapabilities), [hostCapabilities]);
  const observer = usePublishRuntimeObserver();
  const host = React.useMemo(() => createPilotDeckDistillPageHost(context, observer), [context, observer]);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void context.loadDirectory({ signal: controller.signal })
      .then(() => listDefinitions({ signal: controller.signal }))
      .then(() => { if (mounted) setReady(true); })
      .catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { mounted = false; controller.abort(); };
  }, [context]);
  if (error) return <div role="alert">{error}</div>;
  if (!ready) return null;
  return <DistillPageHostProvider value={{ ...host, tenantId: context.readTenant(), navigate: (path, options) => navigate(pilotDeckSopDestination(path), options) }}>{children}</DistillPageHostProvider>;
}
