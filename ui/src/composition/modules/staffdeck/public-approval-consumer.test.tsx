import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../utils/api';
import { usePublicApprovalInbox } from './public-approval-consumer';
import { PublicApprovalInboxMount } from './public-approval-inbox-mount';
import type { ApprovalStatus } from './public-approval-client';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const request = vi.mocked(authenticatedFetch);
const approval = { waitId: 'wait', revision: 4, skillId: 'sop', version: '1', nodeId: 'human', assigneeUserId: 'approver' };
const status = { sessionId: 'session', revision: 4, state: {}, approval };
beforeEach(() => vi.clearAllMocks());

it('waits for the normal approver login before requesting approval status', async () => {
  const onError = vi.fn();
  const { result } = renderHook(() => usePublicApprovalInbox({ scope: { sessionKey: 'session' }, readApproverBearer: () => '', onError }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(request).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(result.current.error).toBe('');
});

it('uses one original request ID for a failed human reply retry, then refreshes after receipt', async () => {
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status })))
    .mockResolvedValueOnce(new Response('{"error":{"code":"TEMPORARY","message":"Retry"}}', { status: 503 }))
    .mockImplementationOnce(async (_path, init) => new Response(JSON.stringify({ accepted: true, duplicate: true, sessionId: 'session', requestId: JSON.parse(String((init as RequestInit)?.body)).requestId, revision: 5, message: 'continue' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: null })));
  const prepared = vi.fn();
  const { result } = renderHook(() => usePublicApprovalInbox({ scope: { sessionKey: 'session', projectKey: 'project' }, readApproverBearer: () => 'normal-login', onPrepared: prepared }));
  await waitFor(() => expect(result.current.status?.approval).toEqual(approval));
  await act(async () => { await result.current.onReply(approval, '  approved  '); });
  expect(result.current.error).toContain('Retry');
  const first = JSON.parse(String((request.mock.calls[1][1] as RequestInit)?.body));
  await act(async () => { await result.current.onReply(approval, 'approved'); });
  const second = JSON.parse(String((request.mock.calls[2][1] as RequestInit)?.body));
  expect(second.requestId).toBe(first.requestId);
  expect(first).toMatchObject({ sessionKey: 'session', projectKey: 'project', source: 'human', waitId: 'wait', expectedRevision: 4, message: 'approved' });
  expect(prepared).toHaveBeenCalledWith('continue');
});

it('reports missing admitted session mapping without a request or inferred session ID', async () => {
  const { result } = renderHook(() => usePublicApprovalInbox({ scope: null, readApproverBearer: () => 'normal-login' }));
  await waitFor(() => expect(result.current.error).toBe('SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE'));
  expect(request).not.toHaveBeenCalled();
  await act(async () => { await result.current.onReply(approval, 'approved'); });
  expect(request).not.toHaveBeenCalled();
});

it('mounts only the injected canonical view with authenticated pinned status', async () => {
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status })));
  const Inbox = vi.fn(({ status: snapshot }: { status: ApprovalStatus | null }) => <div>{snapshot?.approval?.skillId}</div>);
  render(<PublicApprovalInboxMount scope={{ sessionKey: 'session' }} readApproverBearer={() => 'normal-login'} Inbox={Inbox} />);
  await screen.findByText('sop');
  expect(Inbox).toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith('/api/sop/status?sessionKey=session', expect.objectContaining({ headers: { 'X-StaffDeck-Approver-Authorization': 'Bearer normal-login' } }));
});
