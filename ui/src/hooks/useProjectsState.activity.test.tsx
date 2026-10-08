import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppSocketMessage, Project } from '../types/app';
import { api } from '../utils/api';
import { useProjectsState } from './useProjectsState';
import { compareProjectsBySidebarOrder } from '../components/app-shell/appShellSelection';

vi.mock('../utils/api', () => ({ api: { projects: vi.fn() } }));
const iso = (time: number) => new Date(time).toISOString();
const projects: Project[] = [
  { name: 'recent', displayName: 'Recent', fullPath: '/recent', lastActivity: 2000, sessions: [] },
  { name: 'older', displayName: 'Older', fullPath: '/older', lastActivity: 1000,
    sessions: [{ id: 'web:s_1', title: 'Original', updated_at: iso(1000), lastActivity: iso(1000) }] },
];
const response = (items: Project[], revision: number) => new Response(JSON.stringify(items), {
  headers: { 'X-Projects-Revision': String(revision) },
});
beforeEach(() => {
  vi.mocked(api.projects).mockReset().mockResolvedValue(response(projects, 10));
  vi.spyOn(Date, 'now').mockReturnValue(3000);
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function setup() {
  const navigate = vi.fn();
  const activeSessions = new Set<string>();
  const hook = renderHook(({ latestMessage }: { latestMessage: AppSocketMessage | null }) => useProjectsState({
    navigate, activeSessions, isMobile: false, latestMessage,
  }), { initialProps: { latestMessage: null } as { latestMessage: AppSocketMessage | null } });
  await waitFor(() => expect(hook.result.current.projects).toHaveLength(2));
  act(() => {
    hook.result.current.setSelectedProject(projects[1]);
    hook.result.current.handleSessionSelect(projects[1].sessions![0]);
  });
  return hook;
}
const first = (items: Project[]) => [...items].sort(compareProjectsBySidebarOrder)[0].name;

it.each([true, false])('keeps a just-active project first (same socket frame replay: %s)', async (replay) => {
  const { result, rerender } = await setup();
  const message: AppSocketMessage = { type: 'projects_updated', projects, projectListRevision: 20 };
  if (replay) rerender({ latestMessage: message });
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  if (!replay) rerender({ latestMessage: message });
  expect(first(result.current.projects)).toBe('older');
  expect(result.current.projects.find((p) => p.name === 'older')?.sessions?.[0].updated_at).toBe(iso(3000));
});

it('accepts unrelated HTTP data and session titles while protecting only the pending activity', async () => {
  const { result } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  const updated = [
    { ...projects[0], displayName: 'Updated other project' },
    { ...projects[1], sessions: [{ ...projects[1].sessions![0], id: 'web-s_1', title: 'Server title' }] },
  ];
  vi.mocked(api.projects).mockResolvedValue(response(updated, 20));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  expect(first(result.current.projects)).toBe('older');
  expect(result.current.projects[0].displayName).toBe('Updated other project');
  expect(result.current.projects[1].sessions?.[0]).toMatchObject({ title: 'Server title', updated_at: iso(3000) });
});

it('releases protection on server confirmation and permits subsequent deletion', async () => {
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  const confirmed = [projects[0], { ...projects[1], lastActivity: 3200,
    sessions: [{ ...projects[1].sessions![0], updated_at: iso(3200), lastActivity: iso(3200) }] }];
  rerender({ latestMessage: { type: 'projects_updated', projects: confirmed, projectListRevision: 20 } });
  act(() => rollback?.());
  expect(result.current.projects[1].lastActivity).toBe(3200);
  rerender({ latestMessage: { type: 'projects_updated', projects: [projects[0]], projectListRevision: 30 } });
  expect(result.current.projects.map((p) => p.name)).toEqual(['recent']);
});

it('rolls back a failed send without discarding newer metadata from the server', async () => {
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  const updated = [projects[0], { ...projects[1], sessions: [{ ...projects[1].sessions![0], title: 'Renamed on server' }] }];
  rerender({ latestMessage: { type: 'projects_updated', projects: updated, projectListRevision: 20 } });
  act(() => rollback?.());
  expect(first(result.current.projects)).toBe('recent');
  expect(result.current.projects[1].sessions?.[0]).toMatchObject({ title: 'Renamed on server', updated_at: iso(1000) });
});

it('an earlier failure cannot undo a later activity bump in the same session', async () => {
  const { result } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  act(() => rollback?.());
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(4000));
  expect(first(result.current.projects)).toBe('older');
});

it('keeps a different session active when one pending send fails', async () => {
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_2', 'Second'); });
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20 } });
  act(() => rollback?.());
  expect(result.current.projects[1].lastActivity).toBe(4000);
  expect(first(result.current.projects)).toBe('older');
});

it('falls back to a preceding unconfirmed send if a later send in the same session fails', async () => {
  const { result } = await setup();
  let earlier: (() => void) | undefined;
  let later: (() => void) | undefined;
  act(() => { earlier = result.current.bumpSessionActivity('older', 'web:s_1'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { later = result.current.bumpSessionActivity('older', 'web:s_1'); });
  act(() => later?.());
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(3000));
  expect(first(result.current.projects)).toBe('older');
  act(() => earlier?.());
  expect(first(result.current.projects)).toBe('recent');
});

it('moves temporary activity to the real session id without duplicate rows', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-check', 'New'); });
  act(() => result.current.replaceOptimisticInProjects('web:s_2'));
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20 } });
  expect(result.current.projects[1].sessions?.filter((s) => s.id === 'web:s_2')).toHaveLength(1);
  expect(first(result.current.projects)).toBe('older');
});

it('removes failed temporary-session activity as well as its placeholder', async () => {
  const { result } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-check', 'New'); });
  act(() => result.current.dropOptimisticInProjects('new-session-check'));
  expect(first(result.current.projects)).toBe('recent');
  expect(result.current.projects[1].sessions).toHaveLength(1);
});

it('handles a transcript notification only once when selection state changes', async () => {
  const { result, rerender } = await setup();
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20, changedFile: 'older/web-s_1.jsonl' } });
  const count = result.current.externalMessageUpdate;
  expect(count).toBe(1);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  expect(result.current.externalMessageUpdate).toBe(count);
});


it.each([false, true])('honors remote deletion from a complete list (previously paginated: %s)', async (paginated) => {
  const initial = [projects[0], { ...projects[1], sessionMeta: { total: paginated ? 6 : 1, hasMore: paginated },
    sessions: paginated ? Array.from({ length: 5 }, (_, i) => ({ id: `web:s_${i + 1}`, updated_at: iso(1000 - i) })) : projects[1].sessions }];
  vi.mocked(api.projects).mockResolvedValue(response(initial, 10));
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1', '', 'queued'); });
  const remaining = paginated ? initial[1].sessions!.slice(1) : [];
  const deleted = [projects[0], { ...initial[1], lastActivity: 999, sessionMeta: { total: remaining.length, hasMore: false }, sessions: remaining }];
  rerender({ latestMessage: { type: 'projects_updated', projects: deleted, projectListRevision: 20 } });
  expect(result.current.projects[1].sessions?.some((s) => s.id === 'web:s_1')).toBe(false);
  expect(first(result.current.projects)).toBe('recent');
  act(() => rollback?.());
  vi.mocked(api.projects).mockResolvedValue(response(deleted, 30));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  expect(result.current.projects[1].sessions).toEqual(remaining);
});

it('keeps an unconfirmed session omitted from a truncated preview', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1', '', 'queued'); });
  rerender({ latestMessage: { type: 'projects_updated', projectListRevision: 20, projects: [projects[0], {
    ...projects[1], sessions: [], sessionMeta: { total: 6, hasMore: true },
  }] } });
  expect(result.current.projects[1].sessions?.[0].id).toBe('web:s_1');
});

it('rolls back a failed startup after migration to its real ID', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-failed', 'New', 'failed-run'); });
  act(() => result.current.replaceOptimisticInProjects('web:s_failed'));
  act(() => result.current.dropOptimisticInProjects('web:s_failed'));
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20 } });
  expect(first(result.current.projects)).toBe('recent');
  expect(result.current.projects[1].lastActivity).toBe(1000);
  expect(result.current.projects[1].sessions).toEqual(projects[1].sessions);
});

it('retains an accepted startup on inactivity before the transcript snapshot catches up', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-ok', 'New', 'accepted-run'); });
  act(() => result.current.replaceOptimisticInProjects('web:s_ok'));
  rerender({ latestMessage: { type: 'session-input-accepted', sessionId: 'web:s_ok', runId: 'accepted-run' } });
  act(() => result.current.dropOptimisticInProjects('web:s_ok'));
  rerender({ latestMessage: { type: 'projects_updated', projectListRevision: 20, projects: [projects[0], {
    ...projects[1], sessionMeta: { total: 1, hasMore: false },
  }] } });
  expect(first(result.current.projects)).toBe('older');
  expect(result.current.projects[1].sessions?.[0].id).toBe('web:s_ok');
});

it('withdraws only the deleted queue item and releases protection after the last withdrawal', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1', '', 'first'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1', '', 'second'); });
  act(() => result.current.dropOptimisticInProjects('web:s_1'));
  // Dispatch/removal from queue state alone is not a withdrawal.
  rerender({ latestMessage: { type: 'input-queue-state', sessionId: 'web:s_1', revision: 2, items: [] } });
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(4000));
  rerender({ latestMessage: { type: 'session-input-removed', sessionId: 'web:s_1', itemId: 'second' } });
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(3000));
  rerender({ latestMessage: { type: 'session-input-removed', sessionId: 'web:s_1', itemId: 'first' } });
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20 } });
  expect(first(result.current.projects)).toBe('recent');
  expect(result.current.projects[1].lastActivity).toBe(1000);
});

it('retains newer server activity when withdrawing an older queued input', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1', '', 'paused'); });
  const newer = [projects[0], { ...projects[1], lastActivity: 3500,
    sessions: [{ ...projects[1].sessions![0], updated_at: iso(3500), lastActivity: iso(3500) }] }];
  rerender({ latestMessage: { type: 'projects_updated', projects: newer, projectListRevision: 20 } });
  rerender({ latestMessage: { type: 'session-input-removed', sessionId: 'web:s_1', itemId: 'paused' } });
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(3500));
});

it('receives acceptance and withdrawal even when the last React frame is unrelated', async () => {
  let receive!: (message: AppSocketMessage) => void;
  const subscribe = (handler: typeof receive) => { receive = handler; return () => {}; };
  const { result } = renderHook(() => useProjectsState({ navigate: vi.fn(), activeSessions: new Set<string>(), isMobile: false,
    latestMessage: null, subscribe }));
  await waitFor(() => expect(result.current.projects).toHaveLength(2));
  act(() => { result.current.bumpSessionActivity('older', 'new-session-ok', 'New', 'accepted'); });
  act(() => result.current.replaceOptimisticInProjects('web:s_ok'));
  act(() => { receive({ type: 'session-input-accepted', runId: 'accepted' }); receive({ type: 'unrelated' }); });
  act(() => result.current.dropOptimisticInProjects('web:s_ok'));
  expect(result.current.projects[1].sessions?.[0].id).toBe('web:s_ok');
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1', '', 'withdraw'); });
  act(() => { receive({ type: 'session-input-removed', sessionId: 'web:s_1', itemId: 'withdraw' }); receive({ type: 'unrelated' }); });
  expect(result.current.projects[1].sessions?.find((s) => s.id === 'web:s_1')?.updated_at).toBe(iso(1000));
});


it('uses explicit cross-tab deletion even with a truncated or pre-delete snapshot', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1', '', 'queued'); });
  rerender({ latestMessage: { type: 'session-deleted', projectName: 'older', sessionId: 'web-s_1' } });
  expect(result.current.projects[1].sessions).toEqual([]);
  expect(first(result.current.projects)).toBe('recent');
  rerender({ latestMessage: { type: 'projects_updated', projects: [projects[0], {
    ...projects[1], sessionMeta: { total: 10, hasMore: true },
  }], projectListRevision: 20 } });
  expect(result.current.projects[1].sessions).toEqual([]);
  vi.mocked(api.projects).mockResolvedValue(response(projects, 30));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  expect(result.current.projects[1].sessions).toEqual([]);
});

it('decrements the paginated session total when deletion notification precedes the HTTP response', async () => {
  const loaded = Array.from({ length: 10 }, (_, i) => ({ id: `web:s_${i + 1}`, title: `Session ${i + 1}`, updated_at: iso(1000 - i) }));
  const initial = [projects[0], { ...projects[1], sessions: loaded, sessionMeta: { total: 20, hasMore: true } }];
  vi.mocked(api.projects).mockResolvedValue(response(initial, 10));
  const { result, rerender } = await setup();
  // The delete route broadcasts this before res.json({ success: true }).
  rerender({ latestMessage: { type: 'session-deleted', projectName: 'older', sessionId: 'web:s_1' } });
  // AppShell's callback after the successful HTTP response.
  act(() => result.current.handleSessionDelete('web:s_1'));
  const afterDelete = [projects[0], { ...initial[1], sessions: loaded.slice(1, 6), sessionMeta: { total: 19, hasMore: true } }];
  vi.mocked(api.projects).mockResolvedValue(response(afterDelete, 20));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  expect(result.current.projects[1].sessions).toHaveLength(9);
  expect(result.current.projects[1].sessionMeta?.total).toBe(19);
});


it.each(['notification-first', 'callback-first', 'same-batch'])('counts a paginated deletion exactly once (%s)', async (order) => {
  const loaded = Array.from({ length: 10 }, (_, i) => ({ id: `web:s_${i + 1}`, updated_at: iso(1000 - i) }));
  const initial = [projects[0], { ...projects[1], sessions: loaded, sessionMeta: { total: 20, hasMore: true } }];
  vi.mocked(api.projects).mockResolvedValue(response(initial, 10));
  const { result, rerender } = await setup();
  act(() => result.current.setSelectedProject(initial[1]));
  const notify = () => rerender({ latestMessage: { type: 'session-deleted', projectName: 'older', sessionId: 'web-s_1' } });
  const callback = () => act(() => result.current.handleSessionDelete('web:s_1'));
  if (order === 'notification-first') { notify(); callback(); }
  else if (order === 'callback-first') { callback(); notify(); }
  else act(() => { notify(); callback(); });
  notify(); callback();
  for (const project of [result.current.projects[1], result.current.selectedProject!]) {
    expect(project.sessions).toHaveLength(9);
    expect(project.sessionMeta?.total).toBe(19);
    expect(project.sessionMeta!.total! - project.sessions!.length).toBe(10);
  }
  // A delayed pre-delete snapshot must not bring back the row or the old total.
  const stale = [projects[0], { ...initial[1], sessions: loaded.slice(0, 5) }];
  vi.mocked(api.projects).mockResolvedValue(response(stale, 20));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  expect(result.current.projects[1].sessions).toHaveLength(9);
  expect(result.current.projects[1].sessionMeta?.total).toBe(19);
});

it('does not count a startup rollback and its deletion twice', async () => {
  vi.mocked(api.projects).mockResolvedValue(response([projects[0], { ...projects[1], sessionMeta: { total: 1, hasMore: false } }], 10));
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-count', 'New'); });
  act(() => result.current.replaceOptimisticInProjects('web:s_new'));
  expect(result.current.projects[1].sessionMeta?.total).toBe(2);
  rerender({ latestMessage: { type: 'session-deleted', projectName: 'older', sessionId: 'web:s_new' } });
  act(() => result.current.handleSessionDelete('web:s_new'));
  expect(result.current.projects[1].sessionMeta?.total).toBe(1);
  expect(result.current.projects[1].sessions).toHaveLength(1);
});
