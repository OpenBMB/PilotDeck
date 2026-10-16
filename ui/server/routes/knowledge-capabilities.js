import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { bindModuleRequestAbort } from '../module-request-abort.js';
import { createPilotDeckHostCapabilityGateway } from '../pilotdeck-host-capability-gateway.mjs';
import { moduleUpstreamSignal } from '../module-request-abort.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
export function createKnowledgeCapabilitiesRouter({ loadConfig, getGateway, getHostCapabilities, internal = false }) {
  const router = express.Router();
  router.use((req, res, next) => { req.moduleRequestSignal ??= bindModuleRequestAbort(req, res); next(); });
  router.post('/:operation', async (req, res) => {
    try {
      const binding = loadConfig(req)?.modules?.knowledge;
      if (binding?.enabled !== true || binding.contract !== 'knowledge-core/v1') throw failure(503, 'Independent KM is not configured');
      if (internal) {
        const token = binding.capabilitiesCredentialEnv && process.env[binding.capabilitiesCredentialEnv];
        const actual = Buffer.from(req.get('authorization') || '');
        const expected = Buffer.from('Bearer ' + (token || ''));
        if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw failure(401, 'Invalid KM capability credential');
      } else if (String(req.user?.id) !== binding.pilotDeckUserId) throw failure(403, 'Knowledge host user is not bound');
      const space = req.body?.space_id || binding.spaceId;
      if (!binding.spaces?.some(row => row.id === space) || internal && req.body?.tenant_id !== (binding.namespace || 'local')) throw failure(403, 'Knowledge capability space permission denied');
      const principal = { pilotDeckUserId: binding.pilotDeckUserId, tenantId: binding.namespace || 'local', actorUserId: binding.pilotDeckUserId };
      const gateway = await getGateway();
      const signal = moduleUpstreamSignal(req.moduleRequestSignal, binding.timeoutMs || 120_000);
      const port = getHostCapabilities ? await getHostCapabilities({ gateway, principal, signal }) : gateway?.moduleHostCapabilities;
      const capabilities = createPilotDeckHostCapabilityGateway({ gateway, port, principal });
      const call = async (operation, input, callback = false) => {
        const response = await capabilities.call(operation, input, { signal, callback });
        if (response.status < 200 || response.status >= 300) throw failure(response.status, response.body?.message || 'Host capability failed');
        return response;
      };
      const catalog = async () => (await call('list_model_catalog', {})).body;
      if (req.params.operation === 'catalog') return res.json(await catalog());
      if (!internal) throw failure(403, 'Inference requires the KM service credential');
      if (req.params.operation === 'parse') {
        const result = await call('file_parse', { filename: req.body.filename, content_base64: req.body.content_base64 }, true);
        return res.json({ text: result.body.text, file_type: result.body.file_type || result.body.metadata?.fileType });
      }
      if (req.params.operation !== 'model') throw failure(404, 'Unknown KM capability');
      const models = (await catalog()).data.filter(row => row.enabled !== false && row.available !== false);
      const selected = req.body.model_id || models.find(row => row.is_default)?.id || [...models].sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
      if (!selected || !models.some(row => row.id === selected)) throw failure(503, 'Selected KM model unavailable');
      const requestId = req.get('x-km-call-id') || randomUUID();
      const request = { model: selected, systemPrompt: req.body.prompt, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(req.body.payload || {}) }] }], maxOutputTokens: 4096, stream: true };
      const prepared = (await call('model_prepare', { requestId, modelId: selected, request }, true)).body;
      const streamed = await call('model_stream', { requestId, modelId: selected, request: prepared.request }, true);
      let text = '', complete = false;
      for await (const event of modelEvents(streamed.body)) {
        if (event.type === 'error') throw failure(502, event.error?.message || 'Model stream failed');
        if (event.type === 'text_delta') text += event.text;
        if (event.type === 'message_end') complete = true;
      }
      if (!complete) throw failure(502, 'Model stream did not reach a terminal result');
      const result = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure(502, 'Model result must be a JSON object');
      console.info('KM_MODEL_RESULT', JSON.stringify({ call_id: requestId, config_id: selected, provider: prepared.selection?.providerId, model: prepared.selection?.selectedModelId, result_keys: Object.keys(result) }));
      return res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(error.status || 502).json({ detail: error.message });
    }
  });
  return router;
}

async function* modelEvents(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    if (typeof chunk === 'object' && !(chunk instanceof Uint8Array)) {
      if (pending) throw failure(502, 'Mixed model stream framing');
      yield chunk;
      continue;
    }
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending);
}
