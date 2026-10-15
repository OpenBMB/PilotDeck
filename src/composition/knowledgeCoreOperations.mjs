/** Independent KM wire operations shared by runtime and browser gateway. */
const e = value => encodeURIComponent(String(value));
const id = (input, snake, camel) => {
  const value = input[snake] ?? input[camel];
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${snake} is required`), { status: 422 });
  return e(value);
};
const kb = i => '/knowledge-bases/' + id(i, 'knowledge_base_id', 'knowledgeBaseId');
const doc = i => '/documents/' + id(i, 'document_id', 'documentId');
const suggestion = i => '/suggestions/' + id(i, 'suggestion_id', 'suggestionId');
const operation = (method, path, fields = [], query = []) => Object.freeze({ method, path, fields, query, write: method !== 'GET' });
export const KNOWLEDGE_CORE_OPERATIONS = Object.freeze({
  identity: operation('GET', () => '/identity'),
  list_models: operation('GET', () => '/models'),
  list_spaces: operation('GET', () => '/spaces'),
  create_space: operation('POST', () => '/spaces', ['id', 'name']),
  list_bindings: operation('GET', () => '/bindings'),
  bind_base: operation('POST', i => kb(i) + '/bindings', ['space_id', 'hidden']),
  update_binding: operation('PUT', i => kb(i) + '/binding', ['hidden', 'status', 'metadata']),
  list_bases: operation('GET', () => '/knowledge-bases'),
  create_base: operation('POST', () => '/knowledge-bases', ['name', 'description', 'capability_scope', 'metadata']),
  get_base: operation('GET', kb),
  update_base: operation('PUT', kb, ['expected_updated_at', 'name', 'description', 'status', 'metadata', 'capability_scope']),
  delete_base: operation('DELETE', kb, [], ['permanent']),
  list_versions: operation('GET', i => kb(i) + '/versions'),
  get_branch: operation('GET', i => kb(i) + '/branch'),
  copy_version: operation('POST', i => kb(i) + '/versions/copy', ['version_id', 'expected_updated_at', 'name']),
  sync_base: operation('POST', i => kb(i) + '/versions/sync', ['version_id', 'expected_updated_at']),
  publish_version: operation('POST', i => kb(i) + '/versions/publish', ['version_id', 'expected_updated_at']),
  rollback_version: operation('POST', i => kb(i) + '/versions/rollback', ['version_id', 'expected_updated_at']),
  update_branch: operation('PUT', i => kb(i) + '/branch', ['expected_updated_at', 'name', 'description', 'status', 'metadata']),
  list_documents: operation('GET', i => kb(i) + '/documents'),
  get_document: operation('GET', doc),
  import_document: operation('POST', i => kb(i) + '/documents', ['filename', 'content_base64', 'title', 'model_id', 'metadata', 'capability_scope']),
  import_okf: operation('POST', i => kb(i) + '/okf', ['filename', 'content_base64', 'title']),
  update_document: operation('PUT', doc, ['expected_updated_at', 'content_md', 'title', 'status', 'metadata']),
  delete_document: operation('DELETE', doc),
  list_document_buckets: operation('GET', i => doc(i) + '/buckets'),
  update_bucket: operation('PUT', i => '/buckets/' + id(i, 'bucket_id', 'bucketId'), ['expected_updated_at', 'content_md', 'title', 'summary', 'metadata']),
  list_bucket_chunks: operation('GET', i => '/buckets/' + id(i, 'bucket_id', 'bucketId') + '/chunks'),
  list_document_chunks: operation('GET', i => doc(i) + '/chunks'),
  update_chunk: operation('PUT', i => '/chunks/' + id(i, 'chunk_id', 'chunkId'), ['expected_updated_at', 'content_md', 'summary', 'metadata']),
  get_job: operation('GET', i => '/jobs/' + id(i, 'job_id', 'jobId')),
  list_jobs: operation('GET', () => '/jobs', [], ['status', 'limit']),
  cancel_job: operation('POST', i => '/jobs/' + id(i, 'job_id', 'jobId') + '/cancel'),
  list_okf_concepts: operation('GET', i => kb(i) + '/concepts'),
  get_okf_concept: operation('GET', i => kb(i) + '/concepts/' + id(i, 'concept_id', 'conceptId').replaceAll('%2F', '/')),
  get_bucket: operation('GET', i => '/buckets/' + id(i, 'bucket_id', 'bucketId')),
  get_chunk: operation('GET', i => '/chunks/' + id(i, 'chunk_id', 'chunkId')),
  get_concept: operation('GET', i => '/concepts/' + id(i, 'concept_id', 'conceptId')),
  get_discovery: operation('GET', suggestion),
  upsert_okf_concept: operation('PUT', i => kb(i) + '/concepts/' + id(i, 'concept_id', 'conceptId').replaceAll('%2F', '/'), ['expected_updated_at', 'content_md', 'document_id', 'status']),
  update_concept: operation('PUT', i => '/concepts/' + id(i, 'concept_id', 'conceptId'), ['expected_updated_at', 'content_md', 'title', 'summary', 'document_id']),
  list_concepts: operation('GET', () => '/concepts'),
  upsert_concept: operation('PUT', i => '/concepts/' + id(i, 'concept_id', 'conceptId').replaceAll('%2F', '/'), ['expected_updated_at', 'content_md', 'document_id']),
  export_okf: operation('GET', i => kb(i) + '/okf'),
  lint_okf: operation('POST', i => kb(i) + '/okf/lint'),
  list_discoveries: operation('GET', i => kb(i) + '/suggestions'),
  confirm_discovery: operation('POST', i => suggestion(i) + '/review'),
  review_discovery: operation('POST', i => suggestion(i) + '/review'),
  reject_discovery: operation('POST', i => suggestion(i) + '/reject'),
  export_discovery: Object.freeze({ ...operation('POST', i => suggestion(i) + '/export'), write: false }),
  publish_discovery: operation('POST', i => suggestion(i) + '/publish'),
  query: Object.freeze({ ...operation('POST', () => '/query', ['query', 'knowledge_base_ids', 'version_ids', 'max_chunks', 'max_buckets', 'use_model', 'model_id', 'query_type', 'desired_evidence', 'scope', 'mode', 'document_ids', 'max_bucket_rounds', 'budget_tokens', 'max_depth', 'need_evidence_pack']), write: false }),
  resolve_citation: operation('GET', i => '/citations/' + id(i, 'chunk_id', 'chunkId')),
});
export const KNOWLEDGE_CORE_METHODS = Object.freeze(Object.keys(KNOWLEDGE_CORE_OPERATIONS));
const aliases = { knowledgeBaseIds: 'knowledge_base_ids', expectedUpdatedAt: 'expected_updated_at', contentMd: 'content_md', contentBase64: 'content_base64', versionId: 'version_id', modelId: 'model_id', maxChunks: 'max_chunks', maxBuckets: 'max_buckets', queryType: 'query_type', documentId: 'document_id', sourceSpaceId: 'source_space_id', spaceId: 'space_id' };
export function knowledgeCoreRequest(operationName, input, binding, capabilities) {
  const descriptor = KNOWLEDGE_CORE_OPERATIONS[operationName];
  if (!descriptor || !binding.methods.includes(operationName)) throw Object.assign(new Error(`Knowledge operation '${operationName}' is not declared or supported.`), { status: 400 });
  if (descriptor.write && binding.readOnly) throw Object.assign(new Error('Knowledge binding is read-only'), { status: 403 });
  const value = { ...input };
  for (const [camel, snake] of Object.entries(aliases)) if (value[snake] === undefined && value[camel] !== undefined) value[snake] = value[camel];
  if (['tenant_id', 'tenantId', 'actor', 'actor_id', 'actorUserId', 'actor_user_id', 'agentId', 'agent_id'].some(key => Object.hasOwn(value, key))) throw Object.assign(new Error('Knowledge identity comes from its binding'), { status: 400 });
  const allowed = new Set((binding.spaces || []).map(space => space.id));
  if (capabilities && (capabilities.api_protocol !== 'knowledge-core/v1' || !capabilities.modules || !capabilities.operations))
    throw Object.assign(new Error('Incompatible Knowledge capability catalog'), { status: 503 });
  if (capabilities && !capabilities.modules.spaces && ['space_id', 'source_space_id'].some(key => Object.hasOwn(value, key)))
    throw Object.assign(new Error('Space module is disabled'), { status: 422 });
  for (const [module, fields] of [['catalog', ['knowledge_base_id', 'knowledge_base_ids']], ['versions', ['version_id', 'version_ids']]]) {
    if (capabilities && !capabilities.modules[module] && fields.some(key => Object.hasOwn(value, key)))
      throw Object.assign(new Error(`${module} module is disabled`), { status: 422 });
  }
  const space = operationName === 'bind_base' ? value.source_space_id || binding.spaceId : value.space_id || binding.spaceId;
  const scoped = capabilities ? capabilities.modules.spaces === true && operationName !== 'identity' : true;
  if (scoped && (!space || !allowed.has(space) || operationName === 'bind_base' && !allowed.has(value.space_id))) throw Object.assign(new Error('Knowledge space permission denied'), { status: 403 });
  if (operationName === 'create_space' && !allowed.has(value.id)) throw Object.assign(new Error('Knowledge space permission denied'), { status: 403 });
  const versionAction = ['copy_version', 'sync_base', 'publish_version', 'rollback_version'].includes(operationName);
  if (!['upsert_okf_concept', 'upsert_concept'].includes(operationName) && descriptor.fields.includes('expected_updated_at') && !value.expected_updated_at && (!versionAction || capabilities?.operations.get_branch)) throw Object.assign(new Error('expected_updated_at is required'), { status: 422 });
  let path;
  const advertised = capabilities?.operations[operationName];
  if (advertised) {
    path = advertised.path.replace(/\{([^}:]+)(?::path)?\}/g, (_match, field) => id(value, field, field));
    if (advertised.method !== descriptor.method) throw Object.assign(new Error('Knowledge method mismatch'), { status: 503 });
  } else {
    path = '/api/km/v1' + descriptor.path(value);
    if (capabilities) {
      const normalize = path => path.replace(/\{[^}]+\}/g, '{}');
      const markerInput = new Proxy(value, { get: (target, key) => target[key] ?? `{${String(key)}}` });
      const template = '/api/km/v1' + descriptor.path(markerInput).replaceAll('%7B', '{').replaceAll('%7D', '}');
      if (!Object.values(capabilities.operations).some(row => row.method === descriptor.method && normalize(row.path) === normalize(template)))
        throw Object.assign(new Error(`Knowledge operation '${operationName}' is unavailable in the service configuration`), { status: 501 });
    }
  }
  const url = new URL(path, binding.endpoint);
  if (operationName === 'bind_base') url.searchParams.set('source_space_id', space);
  else if (scoped && !['create_space', 'list_spaces'].includes(operationName)) url.searchParams.set('space_id', space);
  for (const field of descriptor.query) if (value[field] !== undefined) url.searchParams.set(field, String(value[field]));
  const body = descriptor.method === 'GET' || descriptor.method === 'DELETE' ? undefined : Object.fromEntries(descriptor.fields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  if (scoped && ['create_base', 'import_document', 'import_okf', 'query'].includes(operationName)) body.space_id = space;
  if (capabilities?.modules.catalog && ['import_document', 'list_documents'].includes(operationName) && value.knowledge_base_id && !path.includes('/knowledge-bases/')) {
    if (body) body.knowledge_base_id = value.knowledge_base_id;
    else url.searchParams.set('knowledge_base_id', value.knowledge_base_id);
  }
  if (capabilities && !capabilities.operations.update_branch) {
    for (const [module, field] of [['catalog', 'knowledge_base_id'], ['versions', 'version_id']]) {
      if (capabilities.modules[module] && value[field] !== undefined && !(field === 'version_id' && versionAction) && !(field === 'knowledge_base_id' && path.includes('/knowledge-bases/'))) {
        url.searchParams.set(field, String(value[field]));
      }
    }
    for (const field of ['document_id']) if (['import_okf', 'upsert_concept'].includes(operationName) && value[field] !== undefined) body[field] = value[field];
  }
  if (operationName === 'query') { body.use_model ??= true; body.max_chunks ??= value.limit ?? 6; }
  return { url, method: descriptor.method, body };
}

export async function knowledgeCoreCapabilities(binding, fetchImpl = fetch, signal) {
  const token = binding.credentialEnv ? process.env[binding.credentialEnv]?.trim() : binding.bearer;
  const response = await fetchImpl(new URL('/api/km/config', binding.endpoint), {
    headers: token ? { authorization: `Bearer ${token}` } : {}, signal,
  });
  if (!response.ok) throw Object.assign(new Error('Knowledge capability discovery failed'), { status: 503 });
  const value = await response.json();
  if (value.api_protocol !== 'knowledge-core/v1' || !value.modules || !value.operations)
    throw Object.assign(new Error('Incompatible Knowledge capability catalog'), { status: 503 });
  return value;
}

/** Resolve a REST request through the same registry used by Agent runtime calls. */
export function knowledgeCoreRestRequest(method, path, input, binding, capabilities) {
  const fields = ['knowledge_base_id', 'document_id', 'bucket_id', 'chunk_id', 'job_id', 'suggestion_id', 'concept_id'];
  const markers = Object.fromEntries(fields.map(field => [field, 'KM_' + field]));
  if (capabilities) {
    for (const [name, descriptor] of Object.entries(capabilities.operations)) {
      if (descriptor.method !== method || !KNOWLEDGE_CORE_OPERATIONS[name]) continue;
      const captured = [];
      const expression = descriptor.path.replace('/api/km/v1', '').split('/').map(part => {
        const match = part.match(/^\{([^}:]+)(?::path)?\}$/);
        if (!match) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        captured.push(match[1]); return part.includes(':path') ? '(.+)' : '([^/]+)';
      }).join('/');
      const match = path.match(new RegExp('^' + expression + '$'));
      if (match) return { operation: name, ...knowledgeCoreRequest(name, { ...input,
        ...Object.fromEntries(captured.map((field, index) => [field, decodeURIComponent(match[index + 1])])) }, binding, capabilities) };
    }
  }
  for (const [name, descriptor] of Object.entries(KNOWLEDGE_CORE_OPERATIONS)) {
    if (descriptor.method !== method) continue;
    const template = descriptor.path(markers);
    const captured = [];
    const expression = template.split('/').map(part => {
      const field = fields.find(field => part === markers[field]);
      if (!field) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      captured.push(field);
      return field === 'concept_id' && (template.includes('/knowledge-bases/') || name === 'upsert_concept') ? '(.+)' : '([^/]+)';
    }).join('/');
    const match = path.match(new RegExp('^' + expression + '$'));
    if (!match) continue;
    const identifiers = Object.fromEntries(captured.map((field, index) => [field, decodeURIComponent(match[index + 1])]));
    return { operation: name, ...knowledgeCoreRequest(name, { ...input, ...identifiers }, binding, capabilities) };
  }
  throw Object.assign(new Error('Unknown knowledge operation'), { status: 400 });
}
