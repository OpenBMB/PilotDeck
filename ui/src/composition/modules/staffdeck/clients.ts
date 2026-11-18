import { authenticatedFetch } from '../../../utils/api';
import i18n from 'i18next';

import { ApiError } from '../../../../plugins/staffdeck-sop/src/vendor/DistillPageHost';

export type ModuleRequestOptions = { signal?: AbortSignal; onManagementEnvelope?: (envelope: { result: unknown; runtime?: unknown }) => void };

function localizedSystemError(status: number, code: string | undefined, message: string): string {
  const known = [
    [404, 'SOP_MANAGEMENT_UPSTREAM_FAILED', 'SOP draft not found.', 'draftNotFound'],
    [401, 'SOP_MANAGEMENT_CREDENTIAL_INACTIVE', 'The StaffDeck account credential is inactive.', 'credentialInactive'],
    [412, 'SOP_MANAGEMENT_UPSTREAM_FAILED', 'The SOP draft changed since it was read.', 'draftChanged'],
  ] as const;
  const entry = known.find(([expectedStatus, expectedCode, expectedMessage]) =>
    status === expectedStatus && code === expectedCode && message === expectedMessage);
  return entry ? String(i18n.t(`errors.${entry[3]}`, { ns: 'staffdeck', defaultValue: message })) : message;
}

// Preserve the original error payload contract and shared UI class identity.
export function moduleApiError(status: number, body: string, statusText: string): ApiError {
  const stableCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value) ? value : undefined;
  let message = body;
  let code: string | undefined;
  try {
    const payload = JSON.parse(body);
    const detail = payload.detail ?? payload.message ?? payload.error;
    const topLevelCode = stableCode(payload.code);
    code = topLevelCode;
    if (typeof detail === 'string') {
      message = detail;
      code = topLevelCode ?? stableCode(detail);
    } else if (Array.isArray(detail)) {
      message = detail.map(item => {
        if (typeof item === 'string') return item;
        const msg = typeof item?.msg === 'string' ? item.msg : '';
        const location = Array.isArray(item?.loc) ? item.loc.map(String).filter(Boolean).join('.') : '';
        return location && msg ? `${location}: ${msg}` : msg;
      }).filter(Boolean).join('；');
    } else if (detail && typeof detail === 'object') {
      const value = typeof detail.message === 'string' ? detail.message : typeof detail.detail === 'string' ? detail.detail : '';
      code = stableCode(detail.code) ?? topLevelCode;
      if (value || code) message = value || String(code);
    }
  } catch {}
  const html = /<(?:!doctype|html|head|body)[\s>]/i.test(message);
  // The common bridge is being restored to the source constructor signature.
  // Reflect also accepts that signature while the fixed 0.1.12 stub is present.
  const error = Reflect.construct(ApiError, [status, body, statusText]) as ApiError;
  Object.assign(error, {
    name: 'ApiError', status, body,
    code: html ? 'UPSTREAM_INVALID_RESPONSE' : code,
    message: html ? `服务暂时不可用，请稍后重试 (HTTP ${status})` : localizedSystemError(status, code, message || statusText || `HTTP ${status}`),
  });
  return error;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, init);
  const raw = await response.text();
  if (!response.ok) throw moduleApiError(response.status, raw, response.statusText);
  const body = (raw ? JSON.parse(raw) : {}) as T;
  return body;
}

function moduleResult<T>(body: { result: T }): T {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'result')) {
    throw new Error('StaffDeck module response is missing its result envelope.');
  }
  return body.result;
}

export type StaffDeckKnowledgeClient = {
  call<T>(operation: string, input?: Record<string, unknown>, options?: ModuleRequestOptions): Promise<T>;
};

export const staffDeckKnowledgeClient: StaffDeckKnowledgeClient = {
  async call<T>(operation: string, input: Record<string, unknown> = {}, options: ModuleRequestOptions = {}) {
    const body = await request<{ result: T }>('/api/modules/knowledge/call', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({ operation, input }),
    });
    return moduleResult(body);
  },
};

export const staffDeckCopyClient = {
  async call<T>(operation: 'list_agents' | 'list_knowledge_bases' | 'list_skills' | 'import_resources', input: Record<string, unknown> = {}, options: ModuleRequestOptions = {}): Promise<T> {
    const body = await request<{ result: T }>('/api/modules/staffdeck-copy/call', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({ operation, input }),
    });
    return moduleResult(body);
  },
};

export type SopDefinition = Record<string, unknown> & { id: string };

export type StaffDeckSopClient = {
  listDefinitions(): Promise<{ defaultSopId: string; definitions: SopDefinition[] }>;
  saveDefinition(id: string, definition: SopDefinition): Promise<{ definition: SopDefinition; restartRequired: boolean }>;
  restartRuntime(): Promise<void>;
  status(sessionKey: string, projectKey?: string): Promise<Record<string, unknown> | null>;
};

export type SopManagementStatus = { enabled: true; methods: string[]; agentId: string; tenantId?: string; actorUserId?: string; runtime?: { receipts: unknown[] } };
export type StaffDeckSopManagementClient = {
  status(options?: ModuleRequestOptions): Promise<SopManagementStatus>;
  call<T>(operation: string, input?: Record<string, unknown>, options?: ModuleRequestOptions): Promise<T>;
};

export const staffDeckSopManagementClient: StaffDeckSopManagementClient = {
  status: (options) => request('/api/modules/sop/management', { signal: options?.signal }),
  async call<T>(operation: string, input: Record<string, unknown> = {}, options: ModuleRequestOptions = {}) {
    const body = await request<{ result: T; runtime?: unknown }>('/api/modules/sop/management/call', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({ operation, input }),
    });
    const result = moduleResult(body);
    // Runtime rendering is a separate observation. It cannot turn a successful
    // owner publication into a failed call or cause a second publish.
    try { options.onManagementEnvelope?.(body); } catch {}
    return result;
  },
};

export const staffDeckSopClient: StaffDeckSopClient = {
  listDefinitions: () => request('/api/modules/sop/definitions'),
  async saveDefinition(id, definition) {
    const result = await request<{ definition: SopDefinition; restartRequired: boolean }>(`/api/modules/sop/definitions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ definition }),
    });
    return result;
  },
  async restartRuntime() {
    await request('/api/update/restart', { method: 'POST' });
  },
  async status(sessionKey, projectKey) {
    const query = new URLSearchParams({ sessionKey });
    if (projectKey) query.set('projectKey', projectKey);
    const body = await request<{ status?: Record<string, unknown> }>(`/api/sop/status?${query}`);
    return body.status ?? null;
  },
};
