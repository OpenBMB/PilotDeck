import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();
const SLOTS = ['agentLoop', 'skills', 'tools', 'context', 'modelProvider', 'sop', 'knowledge'];
const PUBLIC_FIELDS = ['enabled', 'provider', 'implementationId', 'frontendModule', 'contract', 'transport', 'methods'];

/**
 * Return the sanitized runtime composition used by the generated frontend.
 * Endpoint URLs, credentials, deployment paths and SOP definitions never cross
 * this boundary. The gateway projection remains the source of live capability
 * truth; config is only used for module identity and contract details.
 */
export function createModuleRuntimeRouter({ loadConfig, getGateway = getPilotDeckGateway } = {}) {
  const readConfig = loadConfig ?? (() => {
    const path = process.env.PILOTDECK_CONFIG_PATH || join(process.env.PILOT_HOME || join(homedir(), '.pilotdeck'), 'pilotdeck.yaml');
    if (!existsSync(path)) return {};
    try { return parseYaml(readFileSync(path, 'utf8')) ?? {}; } catch { return {}; }
  });
  const route = express.Router();
  route.get('/runtime', async (_req, res) => {
    try {
      const config = readConfig() ?? {};
      const gateway = await getGateway();
      const server = await gateway.describeServer();
      const modules = Object.fromEntries(SLOTS.map((slot) => {
        const value = config.modules?.[slot];
        if (value === undefined) return [slot, { enabled: slot === 'sop' || slot === 'knowledge' ? false : true, provider: 'pilotdeck' }];
        const sanitized = Object.fromEntries(PUBLIC_FIELDS
          .filter((field) => value[field] !== undefined)
          .map((field) => [field, field === 'methods' && Array.isArray(value[field]) ? [...value[field]] : value[field]]));
        return [slot, sanitized];
      }));
      return res.json({ modules, gatewayCapabilities: server.capabilities ?? [] });
    } catch (error) {
      return res.status(503).json({
        error: { code: 'MODULE_RUNTIME_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  route.post('/knowledge/query', async (req, res) => {
    try {
      const binding = readConfig()?.modules?.knowledge;
      if (binding?.enabled !== true || typeof binding.endpoint !== 'string') {
        return res.status(501).json({ error: { code: 'MODULE_DISABLED', message: 'Knowledge module is not configured for HTTP queries.' } });
      }
      if (!Array.isArray(binding.methods) || !binding.methods.includes('query')) {
        return res.status(409).json({ error: { code: 'MODULE_CAPABILITY_UNAVAILABLE', message: 'Knowledge module does not advertise query.' } });
      }
      const requestId = `knowledge-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const messageId = `module-http-${requestId}`;
      const input = { ...(req.body ?? {}) };
      if (!input.baseId && typeof binding.defaultBaseId === 'string' && binding.defaultBaseId.trim()) {
        input.baseId = binding.defaultBaseId.trim();
      }
      if (!input.knowledgeBaseIds && typeof binding.defaultBaseId === 'string' && binding.defaultBaseId.trim()) {
        input.knowledgeBaseIds = [binding.defaultBaseId.trim()];
      }
      if (!input.tenantId && typeof binding.tenantId === 'string' && binding.tenantId.trim()) {
        input.tenantId = binding.tenantId.trim();
      }
      if (!input.actorUserId && typeof binding.actorUserId === 'string' && binding.actorUserId.trim()) {
        input.actorUserId = binding.actorUserId.trim();
      }
      if (input.limit === undefined && Number.isInteger(binding.resultLimit) && binding.resultLimit > 0) {
        input.limit = binding.resultLimit;
      }
      const response = await fetch(new URL(binding.callPath || '/v2/module/call', binding.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(Number(binding.timeoutMs) || 10_000),
        body: JSON.stringify({
          kind: 'request', messageId, method: 'module_call', runId: 'knowledge-ui', operationId: 'knowledge-ui', requestId,
          module: 'knowledge', payload: { operation: 'query', input },
        }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || !body || body.kind !== 'response' || body.inReplyTo !== messageId || body.ok !== true) {
        return res.status(response.ok ? 502 : response.status).json({ error: { code: body?.code || 'MODULE_QUERY_FAILED', message: body?.error?.message || 'Knowledge module query failed.' } });
      }
      return res.json({ result: body.payload?.result ?? body.payload });
    } catch (error) {
      return res.status(502).json({ error: { code: 'MODULE_QUERY_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  route.post('/knowledge/citation', async (req, res) => {
    try {
      const binding = readConfig()?.modules?.knowledge;
      if (binding?.enabled !== true || typeof binding.endpoint !== 'string') {
        return res.status(501).json({ error: { code: 'MODULE_DISABLED', message: 'Knowledge module is not configured for HTTP citations.' } });
      }
      if (!Array.isArray(binding.methods) || !binding.methods.includes('resolve_citation')) {
        return res.status(409).json({ error: { code: 'MODULE_CAPABILITY_UNAVAILABLE', message: 'Knowledge module does not advertise resolve_citation.' } });
      }
      const requestId = `knowledge-ui-citation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const messageId = `module-http-${requestId}`;
      const input = { ...(req.body ?? {}) };
      if (!input.tenantId && typeof binding.tenantId === 'string' && binding.tenantId.trim()) {
        input.tenantId = binding.tenantId.trim();
      }
      if (!input.actorUserId && typeof binding.actorUserId === 'string' && binding.actorUserId.trim()) {
        input.actorUserId = binding.actorUserId.trim();
      }
      const response = await fetch(new URL(binding.callPath || '/v2/module/call', binding.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(Number(binding.timeoutMs) || 10_000),
        body: JSON.stringify({
          kind: 'request', messageId, method: 'module_call', runId: 'knowledge-ui', operationId: 'knowledge-ui-citation', requestId,
          module: 'knowledge', payload: { operation: 'resolve_citation', input },
        }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || !body || body.kind !== 'response' || body.inReplyTo !== messageId || body.ok !== true) {
        return res.status(response.ok ? 502 : response.status).json({ error: { code: body?.code || 'MODULE_CITATION_FAILED', message: body?.error?.message || 'Knowledge citation resolve failed.' } });
      }
      return res.json({ result: body.payload?.result ?? body.payload });
    } catch (error) {
      return res.status(502).json({ error: { code: 'MODULE_CITATION_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  return route;
}

export default createModuleRuntimeRouter;
