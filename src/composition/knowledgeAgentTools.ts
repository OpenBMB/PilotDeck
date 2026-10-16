import type { PilotDeckToolDefinition } from '../tool/index.js';
import type { ExternalModuleBinding } from './types.js';
import { createKnowledgeModulePort, createKnowledgeQueryTool } from './domainPorts.js';
import { knowledgeCoreCapabilities, KNOWLEDGE_AGENT_METHODS } from './knowledgeCoreOperations.mjs';
export { KNOWLEDGE_AGENT_METHODS } from './knowledgeCoreOperations.mjs';

const text = { type: 'string', minLength: 1 };
const fields = {
  knowledge_base_id: text, document_id: text, bucket_id: text, chunk_id: text,
  job_id: text, concept_id: text, expected_updated_at: text, title: text,
  content_md: text, filename: text, model_id: text, space_id: text,
};
export const KNOWLEDGE_AGENT_OPERATIONS = {
  list_documents: { required: [], fields: ['knowledge_base_id'], description: 'List current knowledge documents and their revisions.' },
  get_document: { required: ['document_id'], fields: [], description: 'Read a knowledge document and its current updated_at revision.' },
  import_document: { required: ['title', 'content_md'], fields: ['filename', 'knowledge_base_id', 'model_id'], description: 'Create knowledge from Markdown. Returns a background job; poll knowledge_get_job until succeeded before claiming completion.' },
  update_document: { required: ['document_id', 'expected_updated_at', 'content_md'], fields: ['title'], description: 'Edit a document using the revision read from knowledge_get_document. A conflict requires a new read and reconsideration.' },
  delete_document: { required: ['document_id', 'expected_updated_at'], fields: [], description: 'Archive a document at the revision previously read. Archived content no longer appears in new retrieval.' },
  list_document_buckets: { required: ['document_id'], fields: [], description: 'List a document topic buckets and their revisions.' },
  list_document_chunks: { required: ['document_id'], fields: [], description: 'List evidence chunks, source references and revisions.' },
  get_bucket: { required: ['bucket_id'], fields: [], description: 'Read a topic bucket and its revision.' },
  get_chunk: { required: ['chunk_id'], fields: [], description: 'Read an evidence chunk and its revision.' },
  update_bucket: { required: ['bucket_id', 'expected_updated_at', 'content_md'], fields: ['title'], description: 'Edit a topic bucket using its previously read revision.' },
  update_chunk: { required: ['chunk_id', 'expected_updated_at', 'content_md'], fields: [], description: 'Edit an evidence chunk using its previously read revision.' },
  get_job: { required: ['job_id'], fields: [], description: 'Read ingestion status. Only succeeded means the new knowledge is available; failed and cancelled are terminal failures.' },
  cancel_job: { required: ['job_id'], fields: [], description: 'Request cancellation of a knowledge ingestion task.' },
  list_concepts: { required: [], fields: ['knowledge_base_id', 'document_id'], description: 'List Wiki concept pages, content and revisions.' },
  get_concept: { required: ['concept_id'], fields: ['knowledge_base_id'], description: 'Read a Wiki page and its current revision.' },
  upsert_concept: { required: ['concept_id', 'content_md', 'mode'], fields: ['document_id', 'knowledge_base_id', 'expected_updated_at'], description: 'Create or edit a Wiki page. mode=create must not replace an existing page; mode=edit requires its previously read updated_at.' },
  resolve_citation: { required: ['chunk_id'], fields: [], description: 'Read the original evidence behind a knowledge citation.' },
} as const;
const writes = new Set(['import_document', 'update_document', 'delete_document', 'update_bucket', 'update_chunk', 'cancel_job', 'upsert_concept']);

export async function createKnowledgeAgentTools(binding: ExternalModuleBinding): Promise<PilotDeckToolDefinition[]> {
  const methods = binding.agentMethods ?? (binding.methods.includes('query') ? ['query'] : []);
  if (methods.some(method => !binding.methods.includes(method) || !KNOWLEDGE_AGENT_METHODS.includes(method))) throw new Error('Agent knowledge method is not declared or supported');
  if (methods.length === 0) return [];
  const port = createKnowledgeModulePort(binding);
  const capabilities = binding.contract === 'knowledge-core/v1' ? await knowledgeCoreCapabilities(binding) : undefined;
  const result: PilotDeckToolDefinition[] = [];
  for (const method of methods) {
    const aliases: Record<string, string> = { list_concepts: 'list_okf_concepts', get_concept: 'get_okf_concept', upsert_concept: 'upsert_okf_concept' };
    const advertised = capabilities?.operations[method] ?? capabilities?.operations[aliases[method]];
    if (capabilities && !advertised) continue;
    if (writes.has(method) && binding.readOnly) continue;
    if (method === 'query') { result.push(createKnowledgeQueryTool(port, binding)); continue; }
    const spec = KNOWLEDGE_AGENT_OPERATIONS[method as keyof typeof KNOWLEDGE_AGENT_OPERATIONS];
    if (!spec) continue;
    const properties = Object.fromEntries([...spec.required, ...spec.fields, 'space_id'].map(name => [name,
      name === 'mode' ? { type: 'string', enum: ['create', 'edit'] } : fields[name as keyof typeof fields]]));
    result.push({ name: 'knowledge_' + method, description: spec.description, kind: 'custom',
      inputSchema: { type: 'object', properties, required: [...spec.required], additionalProperties: false },
      isReadOnly: () => !writes.has(method), isConcurrencySafe: () => !writes.has(method),
      async execute(input, context) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Knowledge arguments must be an object');
        const value = { ...input } as Record<string, unknown>;
        if (Object.keys(value).some(key => !Object.hasOwn(properties, key))) throw new Error('Unknown knowledge tool argument');
        for (const name of spec.required) if (typeof value[name] !== 'string' || !String(value[name]).trim()) throw new Error(name + ' is required');
        if (method === 'upsert_concept') {
          if (value.mode !== 'create' && value.mode !== 'edit') throw new Error('mode must be create or edit');
          if (value.mode === 'edit' && !value.expected_updated_at) throw new Error('expected_updated_at is required');
          if (value.mode === 'create' && value.expected_updated_at) throw new Error('Create cannot supply an existing revision');
          value.create_only = value.mode === 'create'; delete value.mode;
        }
        if (method === 'import_document') {
          value.filename ??= 'knowledge.md';
          value.content_base64 = Buffer.from(String(value.content_md), 'utf8').toString('base64'); delete value.content_md;
        }
        const data = await port.call(method, value, context.abortSignal);
        return { content: [{ type: 'json', value: data }], data };
      },
    });
  }
  return result;
}
