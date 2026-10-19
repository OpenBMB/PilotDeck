import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const methods = { modelProvider: ['prepare', 'stream'], tools: ['execute'], skills: ['list', 'read'],
  knowledge: ['query', 'resolve_citation'], context: ['prepare_for_model', 'apply_tool_results', 'recover_from_model_error', 'capture_turn', 'try_auto_compact'] };
const contracts = { modelProvider: 'pilotdeck.model/v1', tools: 'pilotdeck.tools/v1', skills: 'pilotdeck.skills/v1', knowledge: 'staffdeck.knowledge/v1', context: 'pilotdeck.context/v1' };
let faults = [];
const send = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  try {
    const slot = req.url.split('/')[2];
    let data = ''; for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : {};
    if (req.url === '/control') { faults = body.faults ?? []; return send(res, { ok: true }); }
    if (req.url === '/health') return send(res, { ok: true, pid: process.pid });
    if (!methods[slot]) return send(res, { error: 'unknown slot' }, 404);
    if (faults.includes(slot)) return send(res, { error: `FIXTURE_${slot}_DISCONNECTED` }, 503);
    if (req.method === 'GET') return send(res, { protocolVersion: '2.0', implementationId: `source.${slot}`, contract: contracts[slot], transport: 'module-http-v2', methods: methods[slot] });
    const payload = body.payload ?? {};
    const op = payload.operation ?? 'execute';
    appendFileSync(process.env.SOP_FIXTURE_LOG, JSON.stringify({ slot, op, body, at: Date.now() }) + '\n');
    let result;
    if (slot === 'modelProvider' && op === 'prepare') result = { prepared: { request: payload.request, provider: payload.request.provider, model: payload.request.model } };
    else if (slot === 'modelProvider') {
      const request = payload.request;
      const text = JSON.stringify(request);
      const tools = (request.tools ?? []).map(t => t.name);
      const requested = text.match(/PROBE:([a-z_]+)/)?.[1];
      const toolName = requested === 'native' ? 'native_probe' : requested === 'external' ? 'remote_lookup' : requested === 'skill' ? 'read_skill' : requested === 'knowledge' ? 'knowledge_query' : requested === 'citation' ? 'knowledge_resolve_citation' : undefined;
      const seen = toolName && text.includes(`probe-${toolName}`);
      const name = toolName && !seen ? toolName : 'structured_output';
      const failedDependency = text.includes('Module HTTP request') || text.includes('MODULE_UNAVAILABLE') || text.includes('Successful module response contains failure');
      const input = name === 'structured_output' ? { value: { status: failedDependency ? 'failed' : 'completed', reply: 'fixture completed', output: {
        contextMarker: text.includes('EXTERNAL_CONTEXT_OK'), toolMarker: text.includes('NATIVE_TOOL_OK') || text.includes('EXTERNAL_TOOL_OK'),
        skillMarker: text.includes('SKILL_BODY_OK'), knowledgeMarker: text.includes('KNOWLEDGE_HIT_OK'),
        inputIsolated: !text.includes('OTHER_ITEM_SECRET'), tools } } }
        : name === 'read_skill' ? { skillName: 'source-guide' } : name === 'knowledge_query' ? { query: 'source evidence' } : name === 'knowledge_resolve_citation' ? { chunk_id: 'chunk-source' } : {};
      const id = name === 'structured_output' ? 'probe-result' : `probe-${name}`;
      result = { events: [{ type: 'request_started', provider: request.provider, model: request.model }, { type: 'message_start', role: 'assistant' },
        { type: 'tool_call_start', id, name }, { type: 'tool_call_end', toolCall: { id, name, input } }, { type: 'message_end', finishReason: 'tool_call' }] };
    } else if (slot === 'tools') result = { type: 'success', toolCallId: payload.toolCallId, toolName: payload.name, content: [{ type: 'text', text: 'EXTERNAL_TOOL_OK' }] };
    else if (slot === 'skills') result = op === 'list' ? { items: [{ slug: 'source-guide', name: 'Source guide', description: 'Acceptance guide', skillFile: '/fixture/source-guide/SKILL.md' }] }
      : { content: '# Source guide\nSKILL_BODY_OK', scope: 'project', slug: 'source-guide', skill: null };
    else if (slot === 'knowledge') result = op === 'query' ? { hits: [{ id: 'chunk-source', text: 'KNOWLEDGE_HIT_OK', citationId: 'source-citation' }] } : { text: 'KNOWLEDGE_HIT_OK', citationId: 'source-citation' };
    else {
      const input = payload.input ?? {};
      if (op === 'apply_tool_results') result = { messages: [...(input.messages ?? []), ...(input.toolResultMessage ? [input.toolResultMessage] : [])],
        ...(input.toolResultMessage ? { appendedMessages: [input.toolResultMessage] } : {}), diagnostics: [] };
      else if (op === 'recover_from_model_error') result = { type: 'give_up', reason: 'fixture_no_recovery' };
      else if (op === 'capture_turn') result = {};
      else if (op === 'try_auto_compact') result = { type: 'skipped', snapshot: { tokens: 0, maxContextTokens: 65536, warningRatio: 0.8, blockingRatio: 0.95, state: 'ok', ratio: 0 } };
      else result = { messages: input.messages ?? [], systemPrompt: 'EXTERNAL_CONTEXT_OK', systemPromptParts: ['EXTERNAL_CONTEXT_OK'], tools: input.tools ?? [], diagnostics: [], boundaries: [] };
    }
    send(res, { kind: 'response', messageId: `response-${body.messageId}`, inReplyTo: body.messageId, requestId: body.requestId, ok: true,
      payload: ['skills', 'knowledge', 'context'].includes(slot) ? { result } : result });
  } catch (error) { send(res, { error: String(error) }, 500); }
});
server.listen(0, '127.0.0.1', () => writeFileSync(process.env.SOP_FIXTURE_READY, JSON.stringify({ port: server.address().port, pid: process.pid })));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
