import { beforeEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../utils/api';
import { createPublicApprovalClient, approvalInboxItem } from './public-approval-client';
vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const request = vi.mocked(authenticatedFetch);
beforeEach(() => vi.clearAllMocks());
it('native approvals use only the existing PD login and original command', async () => {
  const client = createPublicApprovalClient(() => { throw new Error('SD login must not be read'); }, 'pilotdeck');
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status: null })));
  expect(await client.status({ sessionKey: 'native' })).toBeNull();
  expect((request.mock.calls[0][1] as RequestInit).headers).toEqual({});
  request.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, duplicate: false, sessionId: 'native', requestId: 'r', revision: 2 })));
  await client.resume({ sessionKey: 'native', requestId: 'r', waitId: 'w', expectedRevision: 1, message: 'Approved' });
  expect((request.mock.calls[1][1] as RequestInit).headers).toEqual({});
});
it('reads only the original pinned wait with independent approver login and request abort', async () => {
  const signal = new AbortController().signal;
  const status = { sessionId: 'session', revision: 4, state: {}, approval: { waitId: 'wait', revision: 4, skillId: 'sop', version: '1.2.3', nodeId: 'handoff', assigneeUserId: 'actual-user' } };
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status })));
  const client = createPublicApprovalClient(() => 'approver-login');
  expect(approvalInboxItem(await client.status({ sessionKey: 'session', projectKey: 'project' }, { signal }))).toMatchObject(status.approval);
  expect(request).toHaveBeenCalledWith('/api/sop/status?sessionKey=session&projectKey=project', { headers: { 'X-StaffDeck-Approver-Authorization': 'Bearer approver-login' }, signal });
  expect(approvalInboxItem(null)).toBeNull();
  expect(approvalInboxItem({ ...status, approval: { ...status.approval, authority: { role: 'admin' } } } as any)).toEqual({ sessionKey: 'session', ...status.approval });
  expect(() => approvalInboxItem({ ...status, approval: { ...status.approval, nodeId: '' } })).toThrow('incomplete');
});
it('posts original request/wait/revision once and accepts only matching receipt', async () => {
  const receipt = { accepted: true, duplicate: true, sessionId: 'session', requestId: 'request', revision: 5, message: 'approved' };
  request.mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  const client = createPublicApprovalClient(() => 'normal-login');
  const reply = { sessionKey: 'session', requestId: 'request', waitId: 'wait', expectedRevision: 4, message: 'approved' };
  expect(await client.resume(reply)).toEqual(receipt);
  expect(JSON.parse(String((request.mock.calls[0][1] as RequestInit)?.body))).toEqual({ ...reply, source: 'human' });
  expect((request.mock.calls[0][1] as RequestInit)?.headers).toEqual({ 'X-StaffDeck-Approver-Authorization': 'Bearer normal-login' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('keeps approvalError visible and rejects a request aborted after its HTTP response', async () => {
  const controller = new AbortController();
  const status = { sessionId: 'session', revision: 4, state: {}, approvalError: { code: 'SOP_APPROVAL_ASSIGNEE_REQUIRED', message: 'Missing assignee' } };
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status })));
  expect(await createPublicApprovalClient(() => 'normal-login').status({ sessionKey: 'session' })).toEqual(status);
  expect(approvalInboxItem(status)).toBeNull();
  request.mockImplementationOnce(async () => { controller.abort(); return new Response(JSON.stringify({ status })); });
  await expect(createPublicApprovalClient(() => 'normal-login').status({ sessionKey: 'session' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
it('retains real HTTP error and never sends authority, management key or a missing approver login', async () => {
  const raw = '{"error":{"code":"SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE","message":"Unmapped"}}';
  request.mockResolvedValueOnce(new Response(raw, { status: 503 }));
  const client = createPublicApprovalClient(() => 'normal-login');
  await expect(client.status({ sessionKey: 'session' })).rejects.toMatchObject({ status: 503, code: 'SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE', body: raw });
  const missing = createPublicApprovalClient(() => '');
  await expect(missing.resume({ sessionKey: 'session', requestId: 'request', waitId: 'wait', expectedRevision: 2, message: 'yes' })).rejects.toThrow('normal StaffDeck approver');
  expect(request).toHaveBeenCalledTimes(1);
});
