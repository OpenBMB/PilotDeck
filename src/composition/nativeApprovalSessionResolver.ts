import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { PublicApprovalBinding, PublicApprovalSessionResolver } from './publicApprovalBridge.js';
import type { AgentTranscriptEntry, SessionMetadataValue } from '../session/transcript/TranscriptEntry.js';

export function readPilotDeckSessionAdmission(entries: readonly AgentTranscriptEntry[], sessionKey: string) {
  let admission: SessionMetadataValue['pilotDeckAdmission'];
  for (const entry of entries) {
    if (entry.type !== 'session_metadata' || !entry.metadata.pilotDeckAdmission) continue;
    if (entry.sessionId !== sessionKey || (entry.turnId !== 'host-admission' && !entry.metadata.isSnapshot)) return undefined;
    const next = entry.metadata.pilotDeckAdmission;
    if (next.hostAdapter !== 'pilotdeck' || ![next.ownerId, next.projectKey, next.executionProfileId].every(value => typeof value === 'string' && value.trim())) return undefined;
    if (admission && JSON.stringify(admission) !== JSON.stringify(next)) return undefined;
    admission = next;
  }
  return admission;
}

export function readNativeSessionAdmission(entries: readonly AgentTranscriptEntry[], sessionKey: string) {
  let admission: SessionMetadataValue['staffDeckAdmission'];
  for (const entry of entries) {
    if (entry.type !== 'session_metadata' || !entry.metadata.staffDeckAdmission) continue;
    if (entry.sessionId !== sessionKey || (entry.turnId !== 'host-admission' && !entry.metadata.isSnapshot)) return undefined;
    const next = entry.metadata.staffDeckAdmission;
    if (typeof next !== 'object' || !next || ![next.tenantId, next.agentId, next.pilotDeckUserId, next.projectKey, next.actorUserId, next.credentialId, next.staffDeckOrigin]
      .every(value => typeof value === 'string' && value.trim().length > 0)) return undefined;
    if (admission && (admission.tenantId !== next.tenantId || admission.agentId !== next.agentId
      || admission.pilotDeckUserId !== next.pilotDeckUserId || admission.projectKey !== next.projectKey
      || admission.actorUserId !== next.actorUserId || admission.credentialId !== next.credentialId
      || admission.staffDeckOrigin !== next.staffDeckOrigin)) return undefined;
    admission = next;
  }
  return admission;
}

/** Read the original single-user installation authority without creating another ACL. */
export function readNativeInstallationOwner(databasePath: string): string | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const rows = db.prepare('SELECT id FROM users WHERE is_active = 1').all();
    // Multiple active owners are outside the supported single-user authority.
    return rows.length === 1 ? String(rows[0]!.id) : undefined;
  } catch {
    return undefined;
  } finally { db?.close(); }
}

/** Join original owner, registered project/session catalog and that project's formal binding.
 * No external session ID, pending-wait scan, inferred approver or shadow mapping is used.
 */
export function createNativeApprovalSessionResolver(options: {
  readOwner(): string | undefined;
  listProjects(): Promise<string[]>;
  listSessions(projectKey: string): Promise<readonly { sessionId: string }[]>;
  sessionAdmission(projectKey: string, sessionKey: string): Promise<(PublicApprovalBinding & { projectKey: string }) | undefined>;
}): PublicApprovalSessionResolver {
  return async ({ sessionKey, projectKey, binding, signal }) => {
    signal?.throwIfAborted();
    if (options.readOwner() !== binding.pilotDeckUserId) return undefined;
    const projects = await options.listProjects();
    const selected = projectKey === undefined ? projects : projects.filter(key => resolve(key) === resolve(projectKey));
    const matches: string[] = [];
    for (const key of selected) {
      signal?.throwIfAborted();
      if (!(await options.listSessions(key)).some(session => session.sessionId === sessionKey)) continue;
      const actual = await options.sessionAdmission(key, sessionKey);
      if (!actual || actual.tenantId !== binding.tenantId || actual.agentId !== binding.agentId
        || actual.pilotDeckUserId !== binding.pilotDeckUserId || actual.projectKey !== key) continue;
      matches.push(key);
    }
    if (matches.length !== 1) return undefined;
    signal?.throwIfAborted();
    return { ...binding, sessionKey, projectKey: matches[0] };
  };
}

/** Authenticate the formal source before recording or consuming original admission.
 * Only identifiers are returned; credentials remain in this request process.
 */
export async function authenticateNativeStaffDeckAdmission(input: {
  env: NodeJS.ProcessEnv; projectKey: string; discoveryEndpoint?: string;
  discoveryAgentId?: string; discoveryApiKey?: string; pilotDeckUserId: string;
  signal?: AbortSignal; request?: typeof fetch;
}): Promise<SessionMetadataValue['staffDeckAdmission']> {
  const env = input.env;
  const tenantId = env.STAFFDECK_COPY_TENANT_ID, agentId = env.STAFFDECK_COPY_TARGET_AGENT_ID;
  const actorUserId = env.STAFFDECK_COPY_ACTOR_USER_ID;
  const credentialId = env.STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID;
  const actorBearer = env.STAFFDECK_COPY_USER_TOKEN;
  if (!tenantId || !agentId || !actorUserId || !credentialId || !actorBearer
    || !input.discoveryApiKey || input.discoveryAgentId !== agentId
    || input.pilotDeckUserId !== env.STAFFDECK_COPY_PILOTDECK_USER_ID) return undefined;
  try {
    const origin = new URL(env.STAFFDECK_FORMAL_API_ORIGIN ?? '');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== '/') return undefined;
    if (input.discoveryEndpoint?.replace(/\/$/u, '') !== `${origin.origin}/api/v1`) return undefined;
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const get = async (path: string, bearer: string) => {
      const response = await (input.request ?? fetch)(new URL(path, origin), {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, redirect: 'error', signal,
      });
      if (!response.ok) throw new Error('ADMISSION_AUTH_REJECTED');
      return response.json();
    };
    const actor = await get('/api/auth/me', actorBearer);
    if (actor.id !== actorUserId || actor.tenant_id !== tenantId || actor.disabled === true
      || actor.source !== 'web') return undefined;
    const credentials = await get('/api/auth/me/api-credentials', actorBearer);
    const credential = Array.isArray(credentials) ? credentials.find(row => row.id === credentialId) : undefined;
    const prefix = typeof credential?.key_prefix === 'string' && credential.key_prefix.endsWith('…')
      ? credential.key_prefix.slice(0, -1) : '';
    if (!credential || credential.user_id !== actorUserId || credential.status !== 'active'
      || credential.revoked_at || credential.access !== 'user_full_access' || prefix.length !== 20
      || !input.discoveryApiKey.startsWith(prefix)
      || (credential.expires_at && !(Date.parse(credential.expires_at) > Date.now()))) return undefined;
    // Normal public auth validates the complete key and current tenant/actor/target access.
    const target = await get(`/api/v1/agents/${encodeURIComponent(agentId)}`, input.discoveryApiKey);
    if (target.id !== agentId || target.status !== 'active' || target.is_overall !== false) return undefined;
    return { tenantId, agentId, pilotDeckUserId: input.pilotDeckUserId, projectKey: input.projectKey,
      actorUserId, credentialId, staffDeckOrigin: origin.origin };
  } catch {
    // Do not expose response bodies, bearer strings or transport diagnostics.
    return undefined;
  }
}
