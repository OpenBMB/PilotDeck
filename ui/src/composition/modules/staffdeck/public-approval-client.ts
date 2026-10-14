import { authenticatedFetch } from '../../../utils/api';
import { moduleApiError } from './clients';

export type PinnedApproval = Readonly<{
  waitId: string; revision: number; skillId: string; version: string; nodeId: string; assigneeUserId: string;
}>;
export type ApprovalStatus = Readonly<{
  sessionId: string; revision: number; state: Record<string, unknown>;
  wait?: { id: string; kind: string; [key: string]: unknown };
  approval?: PinnedApproval;
  approvalError?: { code: string; message: string };
}>;
export type ApprovalReceipt = Readonly<{
  accepted: true; duplicate: boolean; sessionId: string; requestId: string; revision: number; message: string;
}>;
export type ApprovalScope = Readonly<{ sessionKey: string; projectKey?: string }>;
export type ApprovalReply = ApprovalScope & Readonly<{
  requestId: string; waitId: string; expectedRevision: number; message: string; slotUpdates?: Record<string, unknown>;
}>;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function assertScope(scope: ApprovalScope) {
  if (!nonempty(scope.sessionKey) || (scope.projectKey !== undefined && !nonempty(scope.projectKey))) {
    throw new Error('Original approval sessionKey and optional projectKey are required.');
  }
}
function approverHeader(bearer: string): Record<string, string> {
  if (!nonempty(bearer)) throw new Error('A normal StaffDeck approver login bearer is required.');
  return { 'X-StaffDeck-Approver-Authorization': `Bearer ${bearer}` };
}
async function json<T>(path: string, init: RequestInit): Promise<T> {
  init.signal?.throwIfAborted();
  const response = await authenticatedFetch(path, init);
  const raw = await response.text();
  init.signal?.throwIfAborted();
  if (!response.ok) throw moduleApiError(response.status, raw, response.statusText);
  try { return JSON.parse(raw) as T; } catch { throw new Error('Approval response is not valid JSON.'); }
}

/** Uses the existing PD authenticated SOP route and an independent normal approver login. */
export function createPublicApprovalClient(readApproverBearer: () => string, hostAdapter: 'staffdeck' | 'pilotdeck' = 'staffdeck') {
  return Object.freeze({
    async status(scope: ApprovalScope, options: { signal?: AbortSignal } = {}): Promise<ApprovalStatus | null> {
      assertScope(scope);
      const headers = hostAdapter === 'pilotdeck' ? {} : approverHeader(readApproverBearer());
      const query = new URLSearchParams({ sessionKey: scope.sessionKey });
      if (scope.projectKey) query.set('projectKey', scope.projectKey);
      const body = await json<{ status: ApprovalStatus | null }>(`/api/sop/status?${query}`, { headers, signal: options.signal });
      if (!body || !Object.prototype.hasOwnProperty.call(body, 'status')) throw new Error('Approval status envelope is missing.');
      if (body.status && body.status.sessionId !== scope.sessionKey) throw new Error('Approval status session does not match the original request.');
      return body.status;
    },
    async resume(reply: ApprovalReply, options: { signal?: AbortSignal } = {}): Promise<ApprovalReceipt> {
      assertScope(reply);
      if (!nonempty(reply.requestId) || !nonempty(reply.waitId) || !nonempty(reply.message) || !Number.isInteger(reply.expectedRevision) || reply.expectedRevision < 0) {
        throw new Error('Original approval request, wait, revision and reply are required.');
      }
      const headers = hostAdapter === 'pilotdeck' ? {} : approverHeader(readApproverBearer());
      const body = await json<ApprovalReceipt>('/api/sop/resume', {
        method: 'POST', headers, signal: options.signal,
        body: JSON.stringify({ sessionKey: reply.sessionKey, ...(reply.projectKey ? { projectKey: reply.projectKey } : {}),
          source: 'human', requestId: reply.requestId, waitId: reply.waitId,
          expectedRevision: reply.expectedRevision, message: reply.message,
          ...(reply.slotUpdates === undefined ? {} : { slotUpdates: reply.slotUpdates }) }),
      });
      if (body?.accepted !== true || body.sessionId !== reply.sessionKey || body.requestId !== reply.requestId || !Number.isInteger(body.revision)) {
        throw new Error('Approval receipt does not match the original command.');
      }
      return body;
    },
  });
}

/** Project only the pinned owner DTO for the canonical inbox consumer. No local wait or approval state. */
export function approvalInboxItem(status: ApprovalStatus | null) {
  if (!status?.approval) return null;
  const pinned = status.approval;
  if (!nonempty(pinned.waitId) || !Number.isInteger(pinned.revision) || pinned.revision < 0 ||
      !nonempty(pinned.skillId) || !nonempty(pinned.version) || !nonempty(pinned.nodeId) || !nonempty(pinned.assigneeUserId)) {
    throw new Error('Pinned approval snapshot is incomplete.');
  }
  return Object.freeze({ sessionKey: status.sessionId, waitId: pinned.waitId, revision: pinned.revision,
    skillId: pinned.skillId, version: pinned.version, nodeId: pinned.nodeId, assigneeUserId: pinned.assigneeUserId });
}
