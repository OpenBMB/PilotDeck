import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSocketMessage, Project } from '../types/app';
import { api } from '../utils/api';
import { useProjectsState } from './useProjectsState';
import { createProjectUpdateScheduler } from '../../server/projectUpdateScheduler.js';

vi.mock('../utils/api', () => ({ api: { projects: vi.fn() } }));

const project = (name: string, revision?: number): Project => ({
  name, displayName: name, fullPath: `/workspace/${name}`,
  lastActivity: 100, projectListRevision: revision,
});

function response(projects: Project[], revision: number) {
  return new Response(JSON.stringify(projects), {
    headers: { 'X-Projects-Revision': String(revision) },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderProjects() {
  const navigate = vi.fn();
  const activeSessions = new Set<string>();
  return renderHook(({ latestMessage }: { latestMessage: AppSocketMessage | null }) => useProjectsState({
    navigate, activeSessions, isMobile: false, latestMessage,
  }), { initialProps: { latestMessage: null } as { latestMessage: AppSocketMessage | null } });
}

describe('new project visibility', () => {
  beforeEach(() => {
    vi.mocked(api.projects).mockReset();
    localStorage.clear();
  });
  afterEach(cleanup);

  it('inserts into a large sidebar immediately without another list request', async () => {
    const existing = Array.from({ length: 250 }, (_, i) => project(`existing-${i}`));
    vi.mocked(api.projects).mockResolvedValue(response(existing, 10));
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.projects).toHaveLength(250));

    act(() => result.current.addCreatedProject(project('new', 20)));

    expect(result.current.projects).toHaveLength(251);
    expect(result.current.projects[0]).toMatchObject({
      name: 'new', sessions: [], sessionMeta: { total: 0, hasMore: false },
    });
    expect(api.projects).toHaveBeenCalledTimes(1);
  });

  it('loads existing projects and General from a pre-creation HTTP scan while retaining the new project', async () => {
    const pending = deferred<Response>();
    vi.mocked(api.projects).mockReturnValue(pending.promise);
    const { result } = renderProjects();
    act(() => result.current.addCreatedProject(project('new', 20)));

    await act(async () => { pending.resolve(response([project('existing'), project('general')], 10)); });

    expect(result.current.projects.map((p) => p.name).sort()).toEqual(['existing', 'general', 'new']);
    expect(result.current.isLoadingProjects).toBe(false);
  });

  it('retains a registration across older snapshots, accepts enrichment, and allows later deletion', async () => {
    vi.mocked(api.projects).mockResolvedValue(response([], 10));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    act(() => result.current.addCreatedProject(project('new', 20)));

    rerender({ latestMessage: { type: 'projects_updated', projects: [], projectListRevision: 15 } });
    expect(result.current.projects).toHaveLength(1);

    const enriched = { ...project('new'), sessions: [{ id: 'real-session', title: 'Hello' }] };
    rerender({ latestMessage: { type: 'projects_updated', projects: [enriched], projectListRevision: 30 } });
    expect(result.current.projects[0].sessions?.[0].id).toBe('real-session');

    rerender({ latestMessage: { type: 'projects_updated', projects: [], projectListRevision: 25 } });
    expect(result.current.projects).toHaveLength(1);

    rerender({ latestMessage: { type: 'projects_updated', projects: [], projectListRevision: 40 } });
    expect(result.current.projects).toEqual([]);
  });

  it('does not let a delayed HTTP response undo an acknowledged socket update', async () => {
    vi.mocked(api.projects).mockResolvedValueOnce(response([], 10));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    const pending = deferred<Response>();
    vi.mocked(api.projects).mockReturnValueOnce(pending.promise);
    let refresh!: Promise<Project[] | null>;
    act(() => { refresh = result.current.fetchProjects({ showLoadingState: false }); });
    act(() => result.current.addCreatedProject(project('new', 20)));
    rerender({ latestMessage: { type: 'projects_updated', projects: [project('new')], projectListRevision: 30 } });

    await act(async () => {
      pending.resolve(response([], 15));
      await refresh;
    });
    expect(result.current.projects.map((p) => p.name)).toEqual(['new']);
  });

  it('deduplicates a registration and preserves sessions already loaded by the watcher', async () => {
    const existing = {
      ...project('existing'), lastActivity: 500,
      sessions: [{ id: 'session-1', title: 'Existing conversation' }],
      sessionMeta: { total: 8, hasMore: true },
    };
    vi.mocked(api.projects).mockResolvedValue(response([existing], 30));
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => result.current.addCreatedProject(project('existing', 20)));

    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0]).toMatchObject({
      sessions: existing.sessions, sessionMeta: existing.sessionMeta, lastActivity: 500,
    });
  });

  it('still delivers transcript changes when their accompanying list is outdated', async () => {
    const existing = { ...project('existing'), sessions: [{ id: 'session-1', title: 'Hello' }] };
    vi.mocked(api.projects).mockResolvedValue(response([existing], 30));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => {
      result.current.setSelectedProject(existing);
      result.current.handleSessionSelect(existing.sessions[0]);
    });
    const previousUpdates = result.current.externalMessageUpdate;
    rerender({ latestMessage: {
      type: 'projects_updated', projects: [], projectListRevision: 20,
      changedFile: 'existing/session-1.jsonl',
    } });
    expect(result.current.externalMessageUpdate).toBe(previousUpdates + 1);
    expect(result.current.projects).toHaveLength(1);
  });

  it.each([true, false])('merges unrelated data before a queued watcher rescan finishes (initial load: %s)', async (initialLoad) => {
    const initial = deferred<Response>();
    const firstScan = deferred<{ projects: Project[]; revision: number }>();
    const followupScan = deferred<{ projects: Project[]; revision: number }>();
    const existing = [project('existing'), project('general')];
    vi.mocked(api.projects).mockReturnValueOnce(initialLoad
      ? initial.promise : Promise.resolve(response(existing, 10)));
    const { result, rerender } = renderProjects();
    if (!initialLoad) await waitFor(() => expect(result.current.projects).toHaveLength(2));
    vi.useFakeTimers();
    const scan = vi.fn().mockReturnValueOnce(firstScan.promise).mockReturnValueOnce(followupScan.promise);
    const scheduler = createProjectUpdateScheduler({
      scan,
      publish: (snapshot: { projects: Project[]; revision: number }) => rerender({ latestMessage: {
        type: 'projects_updated', projects: snapshot.projects, projectListRevision: snapshot.revision,
      } }),
      onError: (error: unknown) => { throw error; },
    });
    try {
      scheduler.schedule('existing-session-change');
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      act(() => result.current.addCreatedProject(project('new', 20)));
      scheduler.schedule('project-created');
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(scan).toHaveBeenCalledTimes(1);

      const updated = [
        { ...project('existing'), sessions: [{ id: 'session-1', title: 'Completed conversation' }] },
        project('general'),
      ];
      await act(async () => {
        initial.resolve(response(existing, 10));
        firstScan.resolve({ projects: updated, revision: 15 });
      });
      // The review's two failures must be fixed even before the rescan returns.
      expect(result.current.projects.map((p) => p.name).sort()).toEqual(['existing', 'general', 'new']);
      expect(result.current.projects.find((p) => p.name === 'existing')?.sessions?.[0]?.id).toBe('session-1');
      expect(result.current.isLoadingProjects).toBe(false);
      expect(scan).toHaveBeenCalledTimes(2);

      await act(async () => { followupScan.resolve({ projects: [...updated, project('new')], revision: 30 }); });
      expect(result.current.projects).toHaveLength(3);
      expect(result.current.projects.filter((p) => p.name === 'new')).toHaveLength(1);
    } finally {
      scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it('protects multiple registrations independently and releases protection for authoritative deletions', async () => {
    vi.mocked(api.projects).mockResolvedValue(response([project('general')], 10));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    act(() => {
      result.current.addCreatedProject(project('first', 20));
      result.current.addCreatedProject(project('second', 40));
    });
    rerender({ latestMessage: { type: 'projects_updated', projects: [project('general'), project('first')], projectListRevision: 30 } });
    expect(result.current.projects.map((p) => p.name).sort()).toEqual(['first', 'general', 'second']);
    rerender({ latestMessage: { type: 'projects_updated', projects: [project('general')], projectListRevision: 35 } });
    expect(result.current.projects.map((p) => p.name).sort()).toEqual(['general', 'second']);
    rerender({ latestMessage: { type: 'projects_updated', projects: [project('general')], projectListRevision: 50 } });
    expect(result.current.projects.map((p) => p.name)).toEqual(['general']);
  });

  it('does not resurrect a locally deleted registration when an older scan arrives', async () => {
    vi.mocked(api.projects).mockResolvedValue(response([project('general')], 10));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    act(() => result.current.addCreatedProject(project('new', 20)));
    act(() => result.current.handleProjectDelete('new'));
    rerender({ latestMessage: { type: 'projects_updated', projects: [project('general')], projectListRevision: 15 } });
    expect(result.current.projects.map((p) => p.name)).toEqual(['general']);
  });
});
