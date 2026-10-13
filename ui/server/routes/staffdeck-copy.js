import { bindModuleRequestAbort, moduleUpstreamSignal } from '../module-request-abort.js';
import express from 'express';

const CONTRACT = 'staffdeck.enterprise-copy/v1';
const OPERATIONS = new Set(['list_agents', 'list_knowledge_bases', 'list_skills', 'import_resources']);

class CopyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requiredText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function configuredText(binding, field) {
  return requiredText(binding[field]) || requiredText(process.env[requiredText(binding[`${field}Env`])]);
}

function bindingFor(config, user, operation) {
  const binding = config?.webui?.staffdeckCopy;
  if (binding?.enabled !== true || binding.contract !== CONTRACT) {
    throw new CopyError(501, 'COPY_UNAVAILABLE', 'StaffDeck copy bridge is not configured.');
  }
  if (!Array.isArray(binding.methods) || !binding.methods.includes(operation)) {
    throw new CopyError(409, 'COPY_CAPABILITY_UNAVAILABLE', `StaffDeck copy bridge does not advertise ${operation}.`);
  }
  const pilotDeckUserId = configuredText(binding, 'pilotDeckUserId');
  if (!pilotDeckUserId) {
    throw new CopyError(501, 'COPY_IDENTITY_UNAVAILABLE', 'StaffDeck copy identity is not configured.');
  }
  if (String(user?.id ?? '') !== pilotDeckUserId) {
    throw new CopyError(403, 'COPY_USER_FORBIDDEN', 'This PilotDeck user is not bound to the StaffDeck copy identity.');
  }
  const endpoint = configuredText(binding, 'endpoint');
  const tenantId = configuredText(binding, 'tenantId');
  const actorUserId = configuredText(binding, 'actorUserId');
  const targetAgentId = configuredText(binding, 'targetAgentId');
  const tokenEnv = requiredText(binding.userTokenEnv);
  const token = tokenEnv && process.env[tokenEnv];
  if (!endpoint || !tenantId || !actorUserId || !targetAgentId || !token) {
    throw new CopyError(501, 'COPY_IDENTITY_UNAVAILABLE', 'StaffDeck copy identity is not configured.');
  }
  for (const moduleAgentId of [config?.modules?.knowledge?.agentId, config?.modules?.sop?.management?.agentId]) {
    if (requiredText(moduleAgentId) && moduleAgentId !== targetAgentId) {
      throw new CopyError(409, 'COPY_TARGET_MISMATCH', 'StaffDeck copy target differs from the configured module agent.');
    }
  }
  let origin;
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid endpoint');
    origin = url.origin;
  } catch {
    throw new CopyError(501, 'COPY_ENDPOINT_INVALID', 'StaffDeck copy endpoint is invalid.');
  }
  return { origin, tenantId, actorUserId, targetAgentId, token, timeoutMs: Number(binding.timeoutMs) || 10_000 };
}

async function officialRequest(binding, method, path, body) {
  const response = await fetch(new URL(path, binding.origin), {
    method,
    redirect: 'error',
    headers: { authorization: `Bearer ${binding.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: moduleUpstreamSignal(binding.signal, binding.timeoutMs),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new CopyError(response.status, 'COPY_UPSTREAM_REJECTED',
      typeof payload?.detail === 'string' ? payload.detail : `StaffDeck copy request failed (${response.status}).`);
  }
  return payload;
}

async function visibleDirectory(binding) {
  const rows = await officialRequest(binding, 'GET', `/api/enterprise/agents?tenant_id=${encodeURIComponent(binding.tenantId)}`);
  if (!Array.isArray(rows)) throw new CopyError(502, 'COPY_DIRECTORY_INVALID', 'StaffDeck directory response is invalid.');
  const visible = rows.filter((row) => row && typeof row.id === 'string' && row.tenant_id === binding.tenantId);
  if (!visible.some((row) => row.id === binding.targetAgentId && row.is_overall === false)) {
    throw new CopyError(403, 'COPY_TARGET_FORBIDDEN', 'The configured target is not a visible employee.');
  }
  return visible;
}

async function verifyFormalUser(binding) {
  let user;
  try {
    user = await officialRequest(binding, 'GET', '/api/auth/me');
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      throw new CopyError(error.status, 'COPY_IDENTITY_REJECTED', 'StaffDeck rejected the configured user credential.');
    }
    throw error;
  }
  if (user?.id !== binding.actorUserId || user?.tenant_id !== binding.tenantId || user?.disabled === true) {
    throw new CopyError(403, 'COPY_IDENTITY_MISMATCH', 'StaffDeck authenticated a different user or tenant.');
  }
}

// The module transport is a different protocol, but must not lend the copy
// actor to another local user or another selected owner.
export async function verifyStaffDeckKnowledgeBinding(config, user, moduleBinding, input, signal) {
  const binding = { ...bindingFor(config, user, 'list_agents'), signal };
  if (moduleBinding?.tenantId !== binding.tenantId || moduleBinding?.actorUserId !== binding.actorUserId
    || moduleBinding?.agentId !== binding.targetAgentId) {
    throw new CopyError(409, 'KNOWLEDGE_IDENTITY_MISMATCH', 'Knowledge tenant, actor and target must match the formal copy binding.');
  }
  for (const [keys, expected] of [[['tenantId', 'tenant_id'], binding.tenantId], [['agentId', 'agent_id'], binding.targetAgentId], [['actorUserId', 'actor_user_id'], binding.actorUserId]]) {
    for (const key of keys) {
      if (input?.[key] !== undefined && input[key] !== expected) {
        throw new CopyError(403, 'KNOWLEDGE_SCOPE_FORBIDDEN', 'The requested Knowledge identity or owner is outside the configured binding.');
      }
    }
  }
  await verifyFormalUser(binding);
  await visibleDirectory(binding);
}

function sourceFrom(directory, value) {
  const sourceId = requiredText(value);
  const source = directory.find((row) => row.id === sourceId);
  if (!source) throw new CopyError(403, 'COPY_SOURCE_FORBIDDEN', 'The source is not visible to the bound StaffDeck user.');
  return source;
}

export function createStaffDeckCopyRouter({ loadConfig }) {
  const route = express.Router();
  route.post('/call', async (req, res) => {
    try {
      const operation = requiredText(req.body?.operation);
      if (!OPERATIONS.has(operation)) throw new CopyError(400, 'COPY_OPERATION_UNSUPPORTED', 'Unsupported StaffDeck copy operation.');
      const binding = { ...bindingFor(loadConfig(req), req.user, operation),
        signal: req.moduleRequestSignal ?? bindModuleRequestAbort(req, res) };
      const input = req.body?.input && typeof req.body.input === 'object' && !Array.isArray(req.body.input) ? req.body.input : {};
      await verifyFormalUser(binding);
      const directory = await visibleDirectory(binding);
      if (operation === 'list_agents') {
        return res.json({ result: directory.map((row) => ({
          id: row.id, tenant_id: row.tenant_id, name: row.name, is_overall: row.is_overall === true, active: row.status === 'active',
          copy_target: row.id === binding.targetAgentId,
          can_manage: row.metadata?.directory_access?.can_manage === true,
        })) });
      }
      const source = sourceFrom(directory, input.sourceAgentId);
      if (operation === 'list_knowledge_bases') {
        const query = new URLSearchParams({ tenant_id: binding.tenantId, agent_id: source.id });
        return res.json({ result: await officialRequest(binding, 'GET', `/api/enterprise/knowledge-bases?${query}`) });
      }
      if (operation === 'list_skills') {
        const query = new URLSearchParams({ tenant_id: binding.tenantId });
        return res.json({ result: await officialRequest(binding, 'GET', `/api/enterprise/agents/${encodeURIComponent(source.id)}/skills?${query}`) });
      }
      if (process.env.PILOTDECK_MODULE_ADMIN === '0') {
        throw new CopyError(403, 'COPY_ADMIN_REQUIRED', 'StaffDeck copy writes are disabled in this PilotDeck host.');
      }
      if (input.targetAgentId !== binding.targetAgentId || source.id === binding.targetAgentId) {
        throw new CopyError(403, 'COPY_SCOPE_FORBIDDEN', 'The requested copy target or source is outside the configured scope.');
      }
      if (!['knowledge_base', 'skill'].includes(input.resourceType)
        || !Array.isArray(input.resourceIds)
        || input.resourceIds.length === 0
        || input.resourceIds.some((id) => !requiredText(id))) {
        throw new CopyError(400, 'COPY_INPUT_INVALID', 'A supported resource type and non-empty resource IDs are required.');
      }
      const result = await officialRequest(binding, 'POST',
        `/api/enterprise/agents/${encodeURIComponent(binding.targetAgentId)}/resources/import`, {
          tenant_id: binding.tenantId,
          source_agent_id: source.id,
          resource_type: input.resourceType,
          resource_ids: input.resourceIds,
        });
      return res.json({ result });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      return res.status(status).json({ error: { code: error?.code || 'COPY_UPSTREAM_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  return route;
}
