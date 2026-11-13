// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobOverview, Project } from '../../../types/app';
import CronPanel from './CronPanel';
import { MemoryRouter } from 'react-router-dom';
import { CronSidebarProvider, useCronSidebar } from '../CronSidebarContext';

const apiMock = vi.hoisted(() => ({
  projects: vi.fn(),
  allCronJobs: vi.fn(),
  cronCreate: vi.fn(),
  cronUpdate: vi.fn(),
  cronDelete: vi.fn(),
  cronRunNow: vi.fn(),
  cronStop: vi.fn(),
  cronDetail: vi.fn(),
}));


const live = vi.hoisted(() => ({ handlers: new Set<(message: any) => void>(), subscribe: vi.fn((handler: (message: any) => void) => { live.handlers.add(handler); return () => live.handlers.delete(handler); }) }));
vi.mock('../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: live.subscribe, isConnected: true }) }));
vi.mock('./CronTaskDetails', () => ({ default: ({ job }: { job: CronJobOverview }) => <section aria-label="Task conversation" data-task-conversation={job.sessionKey || `cron:${job.id}`} /> }));
function taskEvent(job: CronJobOverview | null, id = job?.id || 'job-1') { for (const handler of live.handlers) handler({ type: 'cron-task-changed', taskId: id, job }); }

vi.mock('../../../utils/api', () => ({
  api: apiMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => {
      if (typeof options?.defaultValue !== 'string') return ({ 'cron.title': 'Scheduled tasks', 'cron.workspace.firstRun': 'Your first result is on its way', 'cron.history.empty': 'No runs yet. Try running this task once.', 'cron.workspace.emptyTitle': 'Make room for recurring work', 'cron.workspace.emptyHint': 'Schedule a task once.', 'cron.execution.advanced': 'Advanced execution settings', 'cron.execution.permissions': 'Permissions', 'cron.execution.restricted': 'Restricted by existing permission rules', 'cron.execution.readOnly': 'Read only', 'cron.execution.fullAccess': 'Full Access', 'cron.execution.workspace': 'Execution workspace', 'cron.execution.local': 'Project working directory', 'cron.execution.worktree': 'Isolated Git worktree from committed HEAD', 'cron.execution.model': 'Model', 'cron.execution.defaultModel': 'Use project default', 'confirmDialog.cancel': 'Cancel', 'confirmDialog.close': 'Close', 'confirmDialog.working': 'Working…' } as Record<string, string>)[_key] || _key;
      return options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(options[key] ?? ''));
    },
  }),
}));

const project: Project = {
  name: 'general',
  displayName: 'General',
  fullPath: '/project/general',
};

function jsonResponse<T>(body: T, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function makeJob(overrides: Partial<CronJobOverview>): CronJobOverview {
  return {
    id: 'job-1',
    projectKey: '/project/general',
    cron: '0 8 * * *',
    schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'UTC' },
    timezone: 'UTC',
    revision: 0,
    prompt: 'Run hourly report',
    createdAt: '2026-01-01T00:00:00.000Z',
    recurring: true,
    manualOnly: false,
    status: 'scheduled',
    ...overrides,
  };
}

function TaskSidebarHost() {
  const sidebar = useCronSidebar();
  return <aside aria-label="Shell sidebar"><button onClick={() => sidebar?.setCompact(!sidebar.compact)}>Toggle compact task list</button><div ref={sidebar?.setHost} /></aside>;
}

function setup(jobs: CronJobOverview[], projectEntries: Project[] = [project], options: { initialEntry?: string; onSelect?: () => void } = {}) {
  if (!apiMock.cronDetail.getMockImplementation()) apiMock.cronDetail.mockResolvedValue(jsonResponse({ task: { message: jobs[0]?.prompt || '' }, runs: [], nextRuns: [] }));
  apiMock.projects.mockResolvedValue(jsonResponse(projectEntries));
  apiMock.allCronJobs.mockResolvedValue(jsonResponse({ jobs }));
  apiMock.cronCreate.mockResolvedValue(jsonResponse({ task: { taskId: 'created-task' } }));
  apiMock.cronUpdate.mockResolvedValue(jsonResponse({ updated: true, task: { taskId: 'updated-task' } }));
  apiMock.cronRunNow.mockResolvedValue(jsonResponse({ started: true, taskId: 'job-1', runId: 'manual-run' }));
  apiMock.cronStop.mockResolvedValue(jsonResponse({ stopped: true }));
  apiMock.cronDelete.mockResolvedValue(jsonResponse({ deleted: true }));

  return render(<MemoryRouter initialEntries={[options.initialEntry || '/cron']}>{options.onSelect ? <CronSidebarProvider onSelect={options.onSelect}><TaskSidebarHost /><CronPanel /></CronSidebarProvider> : <CronPanel />}</MemoryRouter>);
}

const findText = async (text: string | RegExp) => (await screen.findAllByText(text))[0];
function createEntry() { return screen.getAllByRole('button', { name: 'New task' })[0]; }
function taskAction(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
  return screen.getByRole('menuitem', { name });
}

function searchInput() {
  if (!screen.queryByRole('textbox', { name: 'Search tasks' })) fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }));
  return screen.getByRole('textbox', { name: 'Search tasks' });
}
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

describe('event-driven task updates', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { cleanup(); vi.useRealTimers(); live.handlers.clear(); });

  it('never polls the catalog and keeps rows, search and focus while live status changes', async () => {
    const job = makeJob({ name: 'Quiet report' }); setup([job]);
    const row = await screen.findByRole('button', { name: 'View task details: Quiet report' });
    const search = searchInput(); fireEvent.change(search, { target: { value: 'Quiet' } }); search.focus();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByRole('button', { name: 'View task details: Quiet report' })).toBe(row);
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    act(() => taskEvent({ ...job, revision: 1, status: 'paused', enabled: false }));
    expect(screen.getByRole('heading', { name: 'Paused' })).toBeTruthy();
    expect((search as HTMLInputElement).value).toBe('Quiet'); expect(document.activeElement).toBe(search);
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('retains an Agent-created task arriving while the initial snapshot is still pending', async () => {
    let resolve!: (response: Response) => void;
    setup([]); apiMock.allCronJobs.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    // Remount so this deferred response owns the initial snapshot.
    cleanup(); render(<MemoryRouter><CronPanel /></MemoryRouter>);
    const job = makeJob({ name: 'Created in another chat', revision: 3 });
    act(() => taskEvent(job));
    await act(async () => resolve(jsonResponse({ jobs: [] })));
    expect(screen.getByRole('button', { name: 'View task details: Created in another chat' })).toBeTruthy();
    act(() => taskEvent({ ...job, revision: 2, name: 'Stale title' }));
    expect(screen.queryByRole('button', { name: 'View task details: Stale title' })).toBeNull();
  });

  it('applies deletion events without a catalog reload', async () => {
    const job = makeJob({ name: 'Removed elsewhere' }); setup([job]);
    await screen.findByRole('button', { name: 'View task details: Removed elsewhere' });
    act(() => taskEvent(null));
    expect(screen.queryByRole('button', { name: 'View task details: Removed elsewhere' })).toBeNull();
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled task management', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('uses the shell sidebar and restores a linked task without adding a third pane', async () => {
    const onSelect = vi.fn();
    const { container } = setup([makeJob({ name: 'First task' }), makeJob({ id: 'second', name: 'Linked task' })], [project], { initialEntry: '/cron?taskId=second', onSelect });
    expect(await screen.findByRole('heading', { name: 'Linked task' })).toBeTruthy();
    const shell = screen.getByRole('complementary', { name: 'Shell sidebar' });
    expect(within(shell).getByRole('button', { name: 'View task details: Linked task' }).getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('.cron-standalone-sidebar')).toBeNull();
    fireEvent.click(within(shell).getByRole('button', { name: 'View task details: First task' }));
    expect(screen.getByRole('heading', { name: 'First task' })).toBeTruthy();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('selects a remaining task when Agent deletes the currently selected task', async () => {
    setup([makeJob({ name: 'First task' }), makeJob({ id: 'second', name: 'Remaining task' })], [project], { initialEntry: '/cron?taskId=job-1' });
    await screen.findByRole('heading', { name: 'First task' });
    act(() => taskEvent(null, 'job-1'));
    expect(await screen.findByRole('heading', { name: 'Remaining task' })).toBeTruthy();
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('retains filtering, selection and task actions in the compact sidebar without refetching', async () => {
    const onSelect = vi.fn();
    setup([makeJob({ name: 'Weekly report' }), makeJob({ id: 'second', name: 'Finished report', status: 'completed' })], [project], { onSelect });
    await screen.findByRole('heading', { name: 'Weekly report' });
    fireEvent.change(searchInput(), { target: { value: 'Weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle compact task list' }));
    const row = screen.getByRole('button', { name: 'View task details: Weekly report' });
    expect(row.classList.contains('compact-project-entry')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('button', { name: 'View task details: Finished report' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Task list options' }));
    const menu = screen.getByRole('menu', { name: 'Task list options' });
    expect(menu.closest('aside')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByLabelText('Search tasks')));
    expect((within(menu).getByLabelText('Search tasks') as HTMLInputElement).value).toBe('Weekly');
    fireEvent.change(within(menu).getByLabelText('Search tasks'), { target: { value: '' } });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'All tasks' }));
    const other = screen.getByRole('button', { name: 'View task details: Finished report' });
    fireEvent.keyDown(other, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    expect(row.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(other);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle compact task list' }));
    expect(screen.getByRole('button', { name: 'View task details: Weekly report' }).classList.contains('tree-row')).toBe(true);
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('collapses the wide task section without hiding its new-task entry or clearing the selection', async () => {
    setup([makeJob({ name: 'Collapsible task' })]);
    await screen.findByRole('heading', { name: 'Collapsible task' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse tasks' }));
    expect(screen.queryByRole('button', { name: 'View task details: Collapsible task' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Collapsible task' })).toBeTruthy();
    expect(createEntry()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand tasks' }));
    expect(screen.getByRole('button', { name: 'View task details: Collapsible task' }).getAttribute('aria-current')).toBe('true');
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('closes the clock before the editor and restores focus to the task action trigger', async () => {
    setup([makeJob({ name: 'Keyboard task' })]);
    await findText('Keyboard task');
    const trigger = screen.getByRole('button', { name: 'Task actions' });
    fireEvent.click(taskAction('Edit'));
    expect(document.activeElement).toBe(screen.getByLabelText('Prompt'));
    fireEvent.click(screen.getByRole('button', { name: 'formControls.chooseTime' }));
    const clock = screen.getByRole('dialog', { name: 'formControls.chooseTime' });
    fireEvent.keyDown(clock, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'formControls.chooseTime' })).toBeNull();
    const editor = screen.getByRole('dialog', { name: 'Edit scheduled task' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(apiMock.cronUpdate).not.toHaveBeenCalled();
  });





  it('edits a task created by Agent with a complex rule without converting the rule', async () => {
    setup([makeJob({ name: 'Agent task', prompt: 'Old instruction', schedule: { type: 'cron', expression: '*/5 9-17 * * 1-5', timezone: 'Asia/Shanghai' }, timezone: 'Asia/Shanghai', executionMode: 'persistent' })]);
    await findText('Agent task');
    fireEvent.click(taskAction('Edit'));
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('custom');
    expect(screen.queryByLabelText('Cron expression')).toBeNull();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-1', expect.objectContaining({
      message: 'Updated instruction',       schedule: { type: 'cron', expression: '*/5 9-17 * * 1-5', timezone: 'Asia/Shanghai' },
    })));
  });

  it('creates a General task using its execution directory rather than its configuration directory', async () => {
    setup([], [{ ...project, fullPath: '/state/general', workspaceCwd: '/work/general', kind: 'general' }]);
    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/state/general' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize the day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    await waitFor(() => expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({ projectKey: '/state/general', workspaceCwd: '/work/general' })));
  });

  it('creates fixed intervals and monthly ordinal weekdays using typed schedules', async () => {
    setup([]);
    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: project.fullPath } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Interval report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'interval' } });
    fireEvent.change(screen.getByLabelText('Interval in minutes'), { target: { value: '30' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    await waitFor(() => expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({ schedule: expect.objectContaining({ type: 'interval', everySeconds: 1800 }) })));
    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: project.fullPath } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Last Friday report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'monthly-weekday' } });
    fireEvent.change(screen.getByLabelText('Week of month'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    await waitFor(() => expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({ schedule: expect.objectContaining({ type: 'monthly', ordinal: -1, weekday: 5, hour: 9, minute: 30 }) })));
  });

  it('pauses future occurrences without stopping the active run', async () => {
    setup([makeJob({ status: 'running', enabled: true, revision: 4 })]);
    await findText('Run hourly report');
    fireEvent.click(taskAction('Pause'));
    await waitFor(() => expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-1', expect.objectContaining({ enabled: false, expectedRevision: 4 })));
    expect(apiMock.cronStop).not.toHaveBeenCalled();
  });

  it('shows admission failures instead of silently treating an HTTP 200 as started', async () => {
    setup([makeJob({})]);
    apiMock.cronRunNow.mockResolvedValue(jsonResponse({ started: false, reason: 'concurrency_limit' }));
    await findText('Run hourly report');
    fireEvent.click(screen.getByRole('button', { name: 'Run Now' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('concurrency_limit');
  });


});

describe('CronPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows active and finished tasks together with their workspace context', async () => {
    setup([
      makeJob({ id: 'job-1', prompt: 'Run hourly report', projectKey: '/project/general', nextRunAt: '2026-01-01T01:00:00.000Z' }),
      makeJob({ id: 'job-2', prompt: 'Unassigned check', projectKey: null }),
      makeJob({ id: 'job-3', prompt: 'Completed old job', status: 'completed' }),
    ]);
    for (const name of ['Run hourly report', 'Unassigned check', 'Completed old job']) {
      expect(await screen.findByRole('button', { name: `View task details: ${name}` })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'View task details: Run hourly report' }).textContent).toContain('General');
    expect(screen.getByRole('button', { name: 'View task details: Unassigned check' }).textContent).toContain('Unassigned');
    expect(screen.getByRole('heading', { name: 'Run hourly report' })).toBeTruthy();
  });

  it('selects a task in the left list and shows its result workspace without a drawer', async () => {
    setup([makeJob({ prompt: 'Visible list task' }), makeJob({ id: 'second', name: 'Second task' })]);
    expect(createEntry()).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'View task details: Second task' }));
    expect(screen.getByRole('heading', { name: 'Second task' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('creates a one-time cron task and refreshes the list', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Run a focused review' },
    });
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: '/project/general' },
    });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2099-01-01' },
    });
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '10:00' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Run a focused review',
        projectKey: '/project/general',
        schedule: expect.objectContaining({ type: 'once' }),
      }));
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
    });
  });

  it('creates a recurring cron task', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Daily digest' },
    });
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: '/project/general' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Time'), {
      target: { value: '08:30' },
    });
    fireEvent.change(screen.getByLabelText('Timezone'), {
      target: { value: 'Asia/Shanghai' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Daily digest',
        projectKey: '/project/general',
        timezone: 'Asia/Shanghai',
        schedule: {
          type: 'cron',
          expression: '30 8 * * *',
          timezone: 'Asia/Shanghai',
        },
      }));
    });
  });

  it('creates a weekly cron task', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Weekly digest' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Shanghai' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { type: 'cron', expression: '30 8 * * 1', timezone: 'Asia/Shanghai' },
      }));
    });
  });

  it('creates a monthly cron task', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Monthly digest' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Shanghai' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { type: 'cron', expression: '30 8 15 * *', timezone: 'Asia/Shanghai' },
      }));
    });
  });

  it('creates a yearly cron task', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Yearly digest' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'yearly' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Shanghai' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { type: 'cron', expression: '30 8 15 9 *', timezone: 'Asia/Shanghai' },
      }));
    });
  });

  it('shows recurrence notices for monthly short dates and leap day', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'monthly' } });

    for (const day of ['29', '30', '31']) {
      fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: day } });
      expect(screen.getByText('Months without this date will not trigger the task.')).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '28' } });
    expect(screen.queryByText('Months without this date will not trigger the task.')).toBeNull();

    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'yearly' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2' } });
    expect((screen.getByLabelText('Day of month') as HTMLSelectElement).options).toHaveLength(29);
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '29' } });
    expect(screen.getByText('This task will only trigger in leap years.')).toBeTruthy();
  });

  it('clamps the yearly day when the selected month is shorter', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Yearly month end' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '31' } });
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'yearly' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '4' } });

    expect((screen.getByLabelText('Day of month') as HTMLSelectElement).value).toBe('30');

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2' } });
    expect((screen.getByLabelText('Day of month') as HTMLSelectElement).options).toHaveLength(29);
  });

  it('saves standard recurrence controls without exposing a name or expression field', async () => {
    setup([]);
    fireEvent.click(createEntry());
    await findText('New scheduled task');
    expect(screen.queryByLabelText('Task name')).toBeNull();
    expect(screen.queryByText(/Keep this computer/)).toBeNull();
    expect(screen.queryByLabelText('Cron expression')).toBeNull();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Daily summary' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: project.fullPath } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    expect(screen.queryByRole('option', { name: 'Custom Cron' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '1' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    await waitFor(() => expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Daily summary', schedule: expect.objectContaining({ expression: '30 8 * * 1' }),
    })));
    expect(apiMock.cronCreate.mock.calls[0][0]).not.toHaveProperty('name');
  });

  it('keeps separate one-time and recurring drafts while creating a task', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-06-20' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:15' } });

    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });

    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-06-20');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('09:15');

    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByLabelText('Day of week') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('08:30');
  });

  it('keeps the task instructions and schedule when creation fails', async () => {
    setup([]);
    apiMock.cronCreate.mockResolvedValue(jsonResponse({ error: 'Temporarily unavailable' }, false));
    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep this input' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: project.fullPath } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    await findText('Temporarily unavailable');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep this input');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('08:30');
  });

  it('validates required create fields before calling the API', async () => {
    setup([]);

    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await findText('Prompt is required.');
    expect(apiMock.cronCreate).not.toHaveBeenCalled();
  });

  it('offers timezone selection and preserves an existing valid alias', async () => {
    setup([makeJob({ prompt: 'Timezone task', timezone: 'US/Eastern', revision: 1 })]);
    await findText('Timezone task');
    fireEvent.click(taskAction('Edit'));
    const timezone = screen.getByRole('combobox', { name: 'Timezone' }) as HTMLSelectElement;
    expect(timezone.value).toBe('US/Eastern');
    expect(screen.queryByRole('textbox', { name: 'Timezone' })).toBeNull();
    fireEvent.change(timezone, { target: { value: 'Asia/Shanghai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-1', expect.objectContaining({ timezone: 'Asia/Shanghai' })));
  });

  it('clears a stale required-instructions error when the user starts describing the task', async () => {
    setup([]);
    fireEvent.click(createEntry());
    await findText('New scheduled task');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    await findText('Prompt is required.');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Check Shanghai weather' } });
    expect(screen.queryByText('Prompt is required.')).toBeNull();
  });

  it.each([
    { name: 'daily', expression: '30 8 * * *', mode: 'daily', time: '08:30' },
    { name: 'weekly', expression: '15 9 * * 2', mode: 'weekly', time: '09:15' },
    { name: 'monthly', expression: '45 6 12 * *', mode: 'monthly', time: '06:45' },
    { name: 'yearly', expression: '0 7 20 11 *', mode: 'yearly', time: '07:00' },
  ])('fills the edit form from a $name schedule', async ({ expression, mode, time }) => {
    setup([makeJob({
      id: `job-${mode}`,
      prompt: `${mode} task`,
      cron: expression,
      schedule: { type: 'cron', expression, timezone: 'Asia/Shanghai' },
      timezone: 'Asia/Shanghai',
      revision: 4,
    })]);

    await findText(`${mode} task`);
    fireEvent.click(taskAction('Edit'));

    await findText('Edit scheduled task');
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('/project/general');
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe(mode);
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe(time);
    expect((screen.getByLabelText('Timezone') as HTMLInputElement).value).toBe('Asia/Shanghai');
  });

  it('updates a task in place and refreshes the list', async () => {
    setup([makeJob({
      id: 'job-edit',
      prompt: 'Weekly report',
      cron: '30 8 * * 1',
      schedule: { type: 'cron', expression: '30 8 * * 1', timezone: 'Asia/Shanghai' },
      timezone: 'Asia/Shanghai',
      revision: 7,
    })]);

    await findText('Weekly report');
    fireEvent.click(taskAction('Edit'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated weekly report' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-edit', {
        notificationPolicy: 'all',
        mode: 'default',
        workspaceMode: 'local',
        modelSelection: null,
        workspaceCwd: '/project/general',
        message: 'Updated weekly report',
        projectKey: '/project/general',
        expectedRevision: 7,
        schedule: { type: 'cron', expression: '45 10 * * 5', timezone: 'Asia/Shanghai' },
        timezone: 'Asia/Shanghai',
      });
      expect(apiMock.cronCreate).not.toHaveBeenCalled();
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
    });
  });

  it('edits a one-time task and keeps the original task id', async () => {
    const runAt = '2099-01-01T02:30:00.000Z';
    setup([makeJob({
      id: 'job-once',
      prompt: 'One-time task',
      cron: '',
      schedule: { type: 'once', runAt },
      timezone: 'Asia/Shanghai',
      recurring: false,
      revision: 3,
    })]);

    await findText('One-time task');
    fireEvent.click(taskAction('Edit'));
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2099-01-01');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('10:30');
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '11:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-once', expect.objectContaining({
        expectedRevision: 3,
        schedule: { type: 'once', runAt: '2099-01-01T03:45:00.000Z' },
      }));
    });
  });

  it('preserves seconds and milliseconds when editing only the prompt of a one-time task', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2099-01-01T10:30:00.000Z'));
    const runAt = '2099-01-01T10:30:45.500Z';
    setup([makeJob({
      id: 'job-once-precision',
      prompt: 'Precise one-time task',
      cron: '',
      schedule: { type: 'once', runAt },
      recurring: false,
      revision: 9,
    })]);

    await findText('Precise one-time task');
    fireEvent.click(taskAction('Edit'));
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('10:30');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated precise task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-once-precision', expect.objectContaining({
        message: 'Updated precise task',
        schedule: { type: 'once', runAt },
      }));
    });
  });

  it('converts a one-time task to the default daily schedule while preserving time', async () => {
    setup([makeJob({
      id: 'job-once-to-cron',
      prompt: 'Convert to recurring',
      cron: '',
      schedule: { type: 'once', runAt: '2099-01-01T10:30:00.000Z' },
      recurring: false,
      revision: 2,
    })]);

    await findText('Convert to recurring');
    fireEvent.click(taskAction('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));

    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('daily');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('10:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-once-to-cron', {
        notificationPolicy: 'all',
        mode: 'default',
        workspaceMode: 'local',
        modelSelection: null,
        workspaceCwd: '/project/general',
        message: 'Convert to recurring',
        projectKey: '/project/general',
        expectedRevision: 2,
        schedule: { type: 'cron', expression: '30 10 * * *', timezone: 'UTC' },
        timezone: 'UTC',
      });
    });
  });

  it('converts a recurring task to the next future one-time date while preserving time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
    setup([makeJob({
      id: 'job-cron-to-once',
      prompt: 'Convert to one-time',
      cron: '30 13 * * *',
      schedule: { type: 'cron', expression: '30 13 * * *', timezone: 'UTC' },
      revision: 2,
    })]);

    await findText('Convert to one-time');
    fireEvent.click(taskAction('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));

    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-01-15');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('13:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-cron-to-once', {
        notificationPolicy: 'all',
        mode: 'default',
        workspaceMode: 'local',
        modelSelection: null,
        workspaceCwd: '/project/general',
        message: 'Convert to one-time',
        projectKey: '/project/general',
        expectedRevision: 2,
        schedule: { type: 'once', runAt: '2026-01-15T13:30:00.000Z' },
        timezone: 'UTC',
      });
    });
  });

  it('uses the task timezone date when converting a recurring task to one-time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-15T01:00:00.000Z'));
    setup([makeJob({
      id: 'job-cron-to-once-date-boundary',
      prompt: 'Convert across date boundary',
      cron: '30 18 * * *',
      schedule: { type: 'cron', expression: '30 18 * * *', timezone: 'America/Los_Angeles' },
      timezone: 'America/Los_Angeles',
      revision: 2,
    })]);

    await findText('Convert across date boundary');
    fireEvent.click(taskAction('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));

    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-01-14');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('18:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-cron-to-once-date-boundary', {
        notificationPolicy: 'all',
        mode: 'default',
        workspaceMode: 'local',
        modelSelection: null,
        workspaceCwd: '/project/general',
        message: 'Convert across date boundary',
        projectKey: '/project/general',
        expectedRevision: 2,
        schedule: { type: 'once', runAt: '2026-01-15T02:30:00.000Z' },
        timezone: 'America/Los_Angeles',
      });
    });
  });

  it('uses the earlier instant when both repeated one-time wall times are in the future', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    setup([]);

    fireEvent.click(createEntry());
    await screen.findByRole('option', { name: 'General' });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'DST fallback task' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '01:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { type: 'once', runAt: '2026-11-01T05:30:00.000Z' },
        timezone: 'America/New_York',
      }));
    });
  });

  it('uses the later instant when the earlier repeated wall time has already passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-11-01T06:15:00.000Z'));
    setup([]);

    fireEvent.click(createEntry());
    await screen.findByRole('option', { name: 'General' });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Later DST fallback task' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '01:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { type: 'once', runAt: '2026-11-01T06:30:00.000Z' },
        timezone: 'America/New_York',
      }));
    });
  });

  it('keeps today when converting a recurring fallback time whose later instant is still future', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-11-01T06:15:00.000Z'));
    setup([makeJob({
      id: 'job-cron-to-once-fallback',
      prompt: 'Convert fallback task',
      cron: '30 1 * * *',
      schedule: { type: 'cron', expression: '30 1 * * *', timezone: 'America/New_York' },
      timezone: 'America/New_York',
      revision: 4,
    })]);

    await findText('Convert fallback task');
    fireEvent.click(taskAction('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));

    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-11-01');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('01:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-cron-to-once-fallback', {
        notificationPolicy: 'all',
        mode: 'default',
        workspaceMode: 'local',
        modelSelection: null,
        workspaceCwd: '/project/general',
        message: 'Convert fallback task',
        projectKey: '/project/general',
        expectedRevision: 4,
        schedule: { type: 'once', runAt: '2026-11-01T06:30:00.000Z' },
        timezone: 'America/New_York',
      });
    });
  });

  it('rejects a one-time wall time that does not exist during DST spring-forward', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setup([]);

    fireEvent.click(createEntry());
    await screen.findByRole('option', { name: 'General' });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'DST gap task' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-08' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '02:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await findText('Run time does not exist in the selected timezone.');
    expect(apiMock.cronCreate).not.toHaveBeenCalled();
  });

  it('keeps separate one-time and recurring drafts while editing a task', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
    setup([makeJob({
      id: 'job-edit-drafts',
      prompt: 'Keep both drafts',
      cron: '30 13 * * 1',
      schedule: { type: 'cron', expression: '30 13 * * 1', timezone: 'UTC' },
      revision: 2,
    })]);

    await findText('Keep both drafts');
    fireEvent.click(taskAction('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-20' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:15' } });

    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByLabelText('Day of week') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('13:30');

    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-01-20');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('14:15');
  });

  it('cancels editing without sending an update request', async () => {
    setup([makeJob({ id: 'job-cancel-edit', prompt: 'Keep original task' })]);

    await findText('Keep original task');
    fireEvent.click(taskAction('Edit'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Unsaved change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await findText('Keep original task');
    expect(screen.queryByText('Edit scheduled task')).toBeNull();
    expect(apiMock.cronUpdate).not.toHaveBeenCalled();
  });

  it('shows the original workspace when it is no longer in the project list', async () => {
    setup([makeJob({ id: 'job-removed-project', projectKey: '/project/removed', prompt: 'Removed workspace task' })]);

    await findText('Removed workspace task');
    fireEvent.click(taskAction('Edit'));

    const workspace = screen.getByLabelText('Workspace') as HTMLSelectElement;
    expect(workspace.value).toBe('/project/removed');
    expect(workspace.disabled).toBe(true);
    expect(workspace.selectedOptions[0]?.textContent).toBe('/project/removed');
  });

  it('keeps edit input and shows a localized message after a version conflict', async () => {
    setup([makeJob({ id: 'job-conflict', prompt: 'Original task', revision: 8 })]);
    apiMock.cronUpdate.mockResolvedValueOnce(jsonResponse({ code: 'cron_conflict' }, false, 409));

    await findText('Original task');
    fireEvent.click(taskAction('Edit'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep this edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await findText('This task has changed. Refresh the list and edit it again.');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep this edit');
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('keeps edit input and shows a localized message when the task starts running', async () => {
    setup([makeJob({ id: 'job-running-conflict', prompt: 'Original running task', revision: 5 })]);
    apiMock.cronUpdate.mockResolvedValueOnce(jsonResponse({ code: 'cron_running' }, false, 409));

    await findText('Original running task');
    fireEvent.click(taskAction('Edit'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep running conflict edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await findText('Stop the running task before saving changes.');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep running conflict edit');
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('keeps edit input and shows a localized message after a general save failure', async () => {
    setup([makeJob({ id: 'job-save-failure', prompt: 'Original failure task', revision: 6 })]);
    apiMock.cronUpdate.mockResolvedValueOnce(jsonResponse({ error: 'Storage unavailable' }, false, 500));

    await findText('Original failure task');
    fireEvent.click(taskAction('Edit'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep failed edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await findText('Failed to save cron task changes.');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep failed edit');
    expect(screen.queryByText('Storage unavailable')).toBeNull();
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('disables running and incomplete edits while allowing advanced cron tasks', async () => {
    setup([
      makeJob({ id: 'running', name: 'Running task', status: 'running' }),
      makeJob({ id: 'advanced', name: 'Advanced task', schedule: { type: 'cron', expression: '*/5 9-17 * * 1-5', timezone: 'UTC' } }),
      makeJob({ id: 'incomplete', name: 'Incomplete task', revision: undefined }),
    ]);
    await findText('Running task');
    expect((taskAction('Edit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Edit' }).title).toBe('Stop the running task before editing.');
    fireEvent.click(screen.getByRole('button', { name: 'View task details: Advanced task' }));
    expect((taskAction('Edit') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'View task details: Incomplete task' }));
    expect((taskAction('Edit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs a scheduled cron job immediately and refreshes', async () => {
    setup([makeJob({ id: 'job-run', prompt: 'Run this now', status: 'scheduled' })]);

    await findText('Run this now');
    fireEvent.click(screen.getByRole('button', { name: /Run Now/ }));

    await waitFor(() => {
      expect(apiMock.cronRunNow).toHaveBeenCalledWith('job-run');
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
    });
  });

  it('stops a running cron job and refreshes', async () => {
    setup([makeJob({ id: 'job-stop', prompt: 'Stop this job', status: 'running' })]);

    await findText('Stop this job');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(apiMock.cronStop).toHaveBeenCalledWith('job-stop');
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
    });
  });

  it('opens the delete confirmation and cancels without deleting', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await findText('Delete this job');
    fireEvent.click(taskAction('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    expect(within(dialog).getByText('Delete this job')).toBeTruthy();
    expect(apiMock.cronDelete).not.toHaveBeenCalled();

    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    expect(document.activeElement).toBe(cancelButton);
    const closeButton = within(dialog).getByRole('button', { name: 'Close' });
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmButton);
    fireEvent.keyDown(confirmButton, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.click(cancelButton);

    expect(screen.queryByRole('dialog', { name: 'Delete cron task?' })).toBeNull();
    expect(apiMock.cronDelete).not.toHaveBeenCalled();
  });

  it('shows only a short preview of a long prompt in the delete confirmation', async () => {
    const longPrompt = 'Long cron task prompt '.repeat(30);
    const preview = `${longPrompt.slice(0, 160)}…`;
    setup([makeJob({ id: 'job-delete', prompt: longPrompt })]);

    await screen.findByRole('button', { name: 'Task actions' });
    fireEvent.click(taskAction('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    const promptPreview = within(dialog).getByText(preview);
    expect(promptPreview.className).toContain('line-clamp-2');
    expect(dialog.textContent).not.toContain(longPrompt);
  });

  it('closes the delete confirmation with Escape without deleting', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await findText('Delete this job');
    fireEvent.click(taskAction('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Delete cron task?' })).toBeNull();
    expect(apiMock.cronDelete).not.toHaveBeenCalled();
  });

  it('deletes a cron job after confirmation and refreshes', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await findText('Delete this job');
    fireEvent.click(taskAction('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    expect(apiMock.cronDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(apiMock.cronDelete).toHaveBeenCalledWith('job-delete');
      expect(apiMock.cronDelete).toHaveBeenCalledTimes(1);
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('dialog', { name: 'Delete cron task?' })).toBeNull();
  });

  it('keeps the delete confirmation open when deletion fails', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);
    apiMock.cronDelete.mockResolvedValueOnce(jsonResponse({ error: 'Delete failed' }, false));

    await findText('Delete this job');
    fireEvent.click(taskAction('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('Delete failed');
    expect(screen.getByRole('dialog', { name: 'Delete cron task?' })).toBeTruthy();
    expect(screen.getAllByText('Delete this job').length).toBeGreaterThan(0);
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('shows an empty active view while preserving finished tasks in the full catalog', async () => {
    setup([makeJob({ id: 'job-complete', prompt: 'Past job', status: 'completed' })]);

    await findText('Past job');
    fireEvent.click(screen.getByLabelText('Task status'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Active' }));
    await findText('No matching tasks.');
    expect(screen.queryByRole('button', { name: 'View task details: Past job' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Task status'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All tasks' }));
    expect(screen.getByRole('button', { name: 'View task details: Past job' })).toBeTruthy();
  });

  it('shows a useful result empty state when next run time is missing', async () => {
    setup([makeJob({ id: 'job-missing-next-run', prompt: 'Missing next run' })]);

    await findText('Missing next run');
    expect(screen.getByRole('region', { name: 'Task conversation' })).toBeTruthy();
  });
});

function formatExpectedTime(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
