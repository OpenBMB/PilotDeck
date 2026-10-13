import type { GatewaySopResumeInput, GatewaySopStatusInput } from '../gateway/protocol/types.js';
import type { StaffDeckApprovalAuthority, StaffDeckSopResumeResult, StaffDeckSopStatusSnapshot } from '../sop/staffdeck/types.js';

export type PublicApprovalBinding = Readonly<{ tenantId: string; agentId: string; pilotDeckUserId: string }>;
/** Returned by the original session authority, never by caller input or a second ACL store. */
export type PublicApprovalSession = PublicApprovalBinding & Readonly<{ sessionKey: string; projectKey?: string }>;
export type PublicApprovalSubject = StaffDeckApprovalAuthority['subject'];
export type PublicApprovalSessionResolver = (input: {
  sessionKey: string; projectKey?: string; binding: PublicApprovalBinding;
  subject: PublicApprovalSubject; signal?: AbortSignal;
}) => Promise<PublicApprovalSession | undefined>;
export type PublicApprovalBridge = Readonly<{
  binding: PublicApprovalBinding;
  dynamicBinding?: boolean;
  status(input: GatewaySopStatusInput, signal?: AbortSignal): Promise<StaffDeckSopStatusSnapshot | null>;
  resume(input: GatewaySopResumeInput, signal?: AbortSignal): Promise<StaffDeckSopResumeResult>;
}>;

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const failure = (status: number, code: string) => Object.assign(new Error(code), { status, code });

export function createPublicApprovalBridge(options: {
  binding: PublicApprovalBinding;
  resolveBinding?: (input: GatewaySopStatusInput) => Promise<PublicApprovalBinding>;
  authenticate(input: { bearer: string; signal?: AbortSignal }): Promise<PublicApprovalSubject>;
  resolveSession?: PublicApprovalSessionResolver;
  status(input: GatewaySopStatusInput): Promise<StaffDeckSopStatusSnapshot | undefined>;
  resume(input: GatewaySopResumeInput & { authority: StaffDeckApprovalAuthority }): Promise<StaffDeckSopResumeResult>;
}): PublicApprovalBridge {
  const binding = Object.freeze({ ...options.binding });
  async function access(input: GatewaySopStatusInput, signal?: AbortSignal) {
    const binding = options.resolveBinding ? await options.resolveBinding(input) : options.binding;
    if (!nonempty(input.sessionKey)) throw failure(400, 'APPROVAL_INPUT_INVALID');
    if (Object.hasOwn(input, 'authority') || Object.hasOwn(input, 'subject')) throw failure(400, 'APPROVAL_AUTHORITY_OVERRIDE');
    const scope = input as GatewaySopStatusInput & { tenantId?: string; agentId?: string };
    if ((scope.tenantId !== undefined && scope.tenantId !== binding.tenantId)
      || (scope.agentId !== undefined && scope.agentId !== binding.agentId)) throw failure(403, 'APPROVAL_SUBJECT_MISMATCH');
    if (![binding.tenantId, binding.agentId, binding.pilotDeckUserId].every(nonempty)) throw failure(503, 'APPROVAL_BINDING_UNAVAILABLE');
    const authorization = input.approverAuthorization;
    if (typeof authorization !== 'string' || authorization.slice(0, 7).toLowerCase() !== 'bearer ' || !nonempty(authorization.slice(7))) {
      throw failure(401, 'APPROVAL_AUTH_REQUIRED');
    }
    const subject = await options.authenticate({ bearer: authorization.slice(7), signal });
    if (subject.tenantId !== binding.tenantId || subject.source !== 'web' || subject.disabled
      || !nonempty(subject.userId) || !['admin', 'member'].includes(subject.role)) throw failure(403, 'APPROVAL_SUBJECT_MISMATCH');
    if (!options.resolveSession) throw failure(503, 'SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE');
    const session = await options.resolveSession({ sessionKey: input.sessionKey, projectKey: input.projectKey, binding, subject, signal });
    if (!session || session.sessionKey !== input.sessionKey || session.tenantId !== binding.tenantId
      || session.agentId !== binding.agentId || session.pilotDeckUserId !== binding.pilotDeckUserId
      || (input.projectKey !== undefined && input.projectKey !== session.projectKey)) {
      throw failure(403, 'SOP_APPROVAL_SESSION_FORBIDDEN');
    }
    signal?.throwIfAborted();
    return { session, subject };
  }
  return Object.freeze({ binding, dynamicBinding: Boolean(options.resolveBinding),
    async status(input, signal) {
      const { session, subject } = await access(input, signal);
      const snapshot = await options.status({ sessionKey: session.sessionKey, projectKey: session.projectKey });
      if (snapshot?.sessionId !== undefined && snapshot.sessionId !== session.sessionKey) throw failure(502, 'SOP_APPROVAL_SESSION_MISMATCH');
      if (snapshot?.approval && subject.role !== 'admin' && snapshot.approval.assigneeUserId !== subject.userId) {
        throw failure(403, 'SOP_APPROVAL_FORBIDDEN');
      }
      return snapshot ?? null;
    },
    async resume(input, signal) {
      if (input.source !== 'human' || !nonempty(input.waitId) || !nonempty(input.requestId) || !nonempty(input.message)
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0) throw failure(400, 'APPROVAL_INPUT_INVALID');
      const { session, subject } = await access(input, signal);
      // No pending-status preflight. The original locked store authorizes first use and receipt replay.
      return options.resume({ sessionKey: session.sessionKey, projectKey: session.projectKey,
        source: 'human', requestId: input.requestId, waitId: input.waitId, message: input.message,
        expectedRevision: input.expectedRevision, ...(input.slotUpdates ? { slotUpdates: input.slotUpdates } : {}),
        authority: { tenantId: session.tenantId, sessionId: session.sessionKey, subject } });
    },
  });
}
