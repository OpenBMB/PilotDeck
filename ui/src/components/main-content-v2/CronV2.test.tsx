// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobOverview, Project } from '../../types/app';
import CronV2 from './CronV2';

const apiMock = vi.hoisted(() => ({
  projects: vi.fn(),
  allCronJobs: vi.fn(),
  cronCreate: vi.fn(),
  cronDelete: vi.fn(),
  cronRunNow: vi.fn(),
  cronStop: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  api: apiMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => (
      typeof options?.defaultValue === 'string' ? options.defaultValue : _key
    ),
  }),
}));

const project: Project = {
  name: 'general',
  displayName: 'General',
  fullPath: '/project/general',
};

function jsonResponse<T>(body: T, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function makeJob(overrides: Partial<CronJobOverview>): CronJobOverview {
  return {
    id: 'job-1',
    projectKey: '/project/general',
    cron: '0 * * * *',
    prompt: 'Run hourly report',
    createdAt: '2026-01-01T00:00:00.000Z',
    recurring: true,
    manualOnly: false,
    status: 'scheduled',
    ...overrides,
  };
}

function setup(jobs: CronJobOverview[]) {
  apiMock.projects.mockResolvedValue(jsonResponse([project]));
  apiMock.allCronJobs.mockResolvedValue(jsonResponse({ jobs }));
  apiMock.cronCreate.mockResolvedValue(jsonResponse({ task: { taskId: 'created-task' } }));
  apiMock.cronRunNow.mockResolvedValue(jsonResponse({ triggered: true }));
  apiMock.cronStop.mockResolvedValue(jsonResponse({ stopped: true }));
  apiMock.cronDelete.mockResolvedValue(jsonResponse({ deleted: true }));

  return render(<CronV2 />);
}

describe('CronV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads active cron jobs and groups them by project', async () => {
    setup([
      makeJob({
        id: 'job-1',
        prompt: 'Run hourly report',
        projectKey: '/project/general',
        nextRunAt: '2026-01-01T01:00:00.000Z',
      }),
      makeJob({ id: 'job-2', prompt: 'Unassigned check', projectKey: null }),
      makeJob({ id: 'job-3', prompt: 'Completed old job', status: 'completed' }),
    ]);

    await screen.findByText('General');
    expect(screen.getAllByText('Next Run').length).toBeGreaterThan(0);
    expect(screen.getByText('Run hourly report')).toBeTruthy();
    expect(screen.getByText(formatExpectedTime('2026-01-01T01:00:00.000Z'))).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('Unassigned check')).toBeTruthy();
    expect(screen.queryByText('Completed old job')).toBeNull();
  });

  it('shows cron sub-navigation and defaults to the task list', async () => {
    setup([makeJob({ prompt: 'Visible list task' })]);

    expect(screen.getByRole('button', { name: 'Task List' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeTruthy();
    await screen.findByText('Visible list task');
  });

  it('creates a one-time cron task and refreshes the list', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');

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
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it('creates a recurring cron task', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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

  it('validates required create fields before calling the API', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await screen.findByText('Prompt is required.');
    expect(apiMock.cronCreate).not.toHaveBeenCalled();
  });

  it('runs a scheduled cron job immediately and refreshes', async () => {
    setup([makeJob({ id: 'job-run', prompt: 'Run this now', status: 'scheduled' })]);

    await screen.findByText('Run this now');
    fireEvent.click(screen.getByRole('button', { name: /Run Now/ }));

    await waitFor(() => {
      expect(apiMock.cronRunNow).toHaveBeenCalledWith('job-run');
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it('stops a running cron job and refreshes', async () => {
    setup([makeJob({ id: 'job-stop', prompt: 'Stop this job', status: 'running' })]);

    await screen.findByText('Stop this job');
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));

    await waitFor(() => {
      expect(apiMock.cronStop).toHaveBeenCalledWith('job-stop');
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it('deletes a cron job and refreshes', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await screen.findByText('Delete this job');
    fireEvent.click(screen.getByTitle('Delete'));

    await waitFor(() => {
      expect(apiMock.cronDelete).toHaveBeenCalledWith('job-delete');
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it('shows an empty state when there are no active cron jobs', async () => {
    setup([makeJob({ id: 'job-complete', prompt: 'Past job', status: 'completed' })]);

    await screen.findByText('No active cron jobs found.');
    expect(screen.queryByText('Past job')).toBeNull();
  });

  it('renders a placeholder when next run time is missing', async () => {
    setup([makeJob({ id: 'job-missing-next-run', prompt: 'Missing next run' })]);

    await screen.findByText('Missing next run');
    expect(screen.getByText('—')).toBeTruthy();
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
