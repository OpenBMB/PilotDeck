import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { DatabaseSync } from 'node:sqlite';

export function readSopConfig() {
  const home = process.env.PILOT_HOME || join(homedir(), '.pilotdeck');
  try { return parse(readFileSync(process.env.PILOTDECK_CONFIG_PATH || join(home, 'pilotdeck.yaml'), 'utf8'))?.modules?.sop; }
  catch { return undefined; }
}

export function readInstallationOwner() {
  let db;
  try {
    db = new DatabaseSync(process.env.DATABASE_PATH || join(process.env.PILOT_HOME || join(homedir(), '.pilotdeck'), 'auth.db'), { readOnly: true });
    const users = db.prepare('SELECT id FROM users WHERE is_active=1').all();
    return users.length === 1 ? String(users[0].id) : undefined;
  } finally { db?.close(); }
}

export const nativeSopError = (code, message, status = 422) => Object.assign(new Error(message), { code, status });

export function createNativeSopService({ config = readSopConfig, request = fetch, modelPort } = {}) {
  const workerId = randomUUID();
  const running = new Map();
  let recovered;
  async function call(operation, input = {}) {
    const profile = config();
    if (profile?.hostAdapter !== 'pilotdeck') throw nativeSopError('SOP_NATIVE_DISABLED', 'PilotDeck SOP host is disabled', 409);
    const token = process.env.SOP_RUNTIME_PUBLISH_TOKEN;
    const response = await request(`${profile.endpoint.replace(/\/+$/u, '')}/v1/management/call`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw nativeSopError(body.error?.code || 'SOP_MANAGEMENT_FAILED', body.error?.message || 'Management failed', response.status);
    return body.result;
  }
  async function recover() {
    recovered ??= call('job_recover', { workerId }).catch(error => { recovered = undefined; throw error; });
    return recovered;
  }
  async function generate(input, kind = 'generate') {
    await recover();
    const job = await call('job_create', { kind, input });
    const controller = new AbortController();
    running.set(job.id, controller);
    void work(job, controller.signal).finally(() => running.delete(job.id));
    return job;
  }
  async function work(job, signal) {
    try {
      await call('job_start', { jobId: job.id, workerId });
      const port = await modelPort();
      const catalog = await port.call('list_model_catalog', {}, { signal });
      const models = catalog.body?.data ?? catalog.body?.items ?? [];
      const selected = job.input.modelId || models.find(m => m.is_default)?.id || models.find(m => m.available !== false)?.id;
      if (!selected) throw new Error('No available PilotDeck model');
      const prompt = generationPrompt(job.input);
      let failure = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const response = await port.call('model_stream', { requestId: `${job.id}:${attempt}`, modelId: selected,
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: prompt + (failure ? `\nRepair this validation error once: ${failure}` : '') }] }],
            maxOutputTokens: 8192 }, budget: { timeoutMs: 180000 } }, { signal });
        if (response.status !== 200) throw new Error('PilotDeck model request failed');
        let output = '', buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === 'error') throw new Error(event.message || 'Model failed');
            if (event.type === 'text_delta') {
              output += event.text;
              await call('job_chunk', { jobId: job.id, workerId, content: event.text });
            }
          }
        }
        try {
          const raw = output.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
          const parsed = JSON.parse(raw);
          await call('job_complete', { jobId: job.id, workerId, content: parsed.draft_skill ?? parsed });
          return;
        } catch (error) {
          if (!['SOP_DEFINITION_INVALID', 'INVALID_SOP', 'INVALID_SOP_GRAPH', 'SOP_ID_MISMATCH'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
          failure = error.message;
          if (attempt === 1) throw error;
          await call('job_chunk_reset', { jobId: job.id, workerId });
        }
      }
    } catch (error) {
      await call(signal.aborted ? 'job_cancel' : 'job_fail', { jobId: job.id, workerId,
        error: signal.aborted ? 'Cancelled' : String(error.message).slice(0, 500) }).catch(() => {});
    }
  }
  return { call, recover, generate, async cancel(jobId) {
    const job = await call('job_cancel', { jobId }); running.get(jobId)?.abort(); return job;
  } };
}

function generationPrompt(input) {
  return `Generate or rewrite a SOP. Return ONLY a JSON object with skill_id, version (semver), name, description, required_info (array of strings), start_node_id, terminal_node_ids, nodes, edges.
Each node has node_id, type (collect_info, response, tool_call, handoff, subflow), instruction. Edges have source_node_id, next_node_id and optional condition. All graph references must exist. Handoff nodes must set assignee_ref to "pilotdeck:owner". Required capabilities belong inside node.capability_refs as required_tool_ids, required_general_skill_ids, required_knowledge_base_ids; only use provided bindings. Child SOP nodes use type subflow, sub_sop_id and sub_sop_version from published definitions. Preserve skill_id on rewrite. Save a draft only; do not claim publication.
Request: ${JSON.stringify(input)}`;
}
