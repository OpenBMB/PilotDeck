// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobOverview, Project } from '../../types/app';
import CronV2 from './CronV2';

const apiMock = vi.hoisted(() => ({
  projects: vi.fn(),
  allCronJobs: vi.fn(),
  cronCreate: vi.fn(),
  cronUpdate: vi.fn(),
  cronDelete: vi.fn(),
  cronRunNow: vi.fn(),
  cronStop: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  api: apiMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => {
      if (typeof options?.defaultValue !== 'string') return _key;
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

function setup(jobs: CronJobOverview[]) {
  apiMock.projects.mockResolvedValue(jsonResponse([project]));
  apiMock.allCronJobs.mockResolvedValue(jsonResponse({ jobs }));
  apiMock.cronCreate.mockResolvedValue(jsonResponse({ task: { taskId: 'created-task' } }));
  apiMock.cronUpdate.mockResolvedValue(jsonResponse({ task: { taskId: 'updated-task' } }));
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
    vi.useRealTimers();
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

  it('creates a weekly cron task', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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

  it('updates the cron expression when the standard fields change', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    const expression = screen.getByLabelText('Cron expression') as HTMLInputElement;

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    expect(expression.value).toBe('30 8 * * *');

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '' } });
    expect(expression.value).toBe('');
    expect(screen.getByText('Cron expression format is invalid.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    expect(screen.queryByText('Cron expression format is invalid.')).toBeNull();

    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '1' } });
    expect(expression.value).toBe('30 8 * * 1');

    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } });
    expect(expression.value).toBe('30 8 15 * *');

    fireEvent.change(screen.getByLabelText('Repeat period'), { target: { value: 'yearly' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } });
    expect(expression.value).toBe('30 8 15 9 *');
  });

  it('updates the standard fields from each supported cron expression', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Linked schedule' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    const expression = screen.getByLabelText('Cron expression');

    fireEvent.change(expression, { target: { value: '15 9 * * 2' } });
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByLabelText('Day of week') as HTMLSelectElement).value).toBe('2');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('09:15');

    fireEvent.change(expression, { target: { value: '45 6 12 * *' } });
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('monthly');
    expect((screen.getByLabelText('Day of month') as HTMLSelectElement).value).toBe('12');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('06:45');

    fireEvent.change(expression, { target: { value: '0 7 20 11 *' } });
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('yearly');
    expect((screen.getByLabelText('Month') as HTMLSelectElement).value).toBe('11');
    expect((screen.getByLabelText('Day of month') as HTMLSelectElement).value).toBe('20');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('07:00');

    fireEvent.change(expression, { target: { value: '5 8 * * *' } });
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('daily');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('08:05');

    fireEvent.change(expression, { target: { value: '30 8 * * 7' } });
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByLabelText('Day of week') as HTMLSelectElement).value).toBe('0');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { type: 'cron', expression: '30 8 * * 0', timezone: expect.any(String) },
      }));
    });
  });

  it('rejects unsupported cron rules and keeps the last valid standard fields', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '*/15 9-17/2 * * 1-5' } });

    expect(screen.getByText('Cron expression format is invalid.')).toBeTruthy();
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('daily');
    fireEvent.click(screen.getByRole('button', { name: /Advanced Cron expression/ }));
    expect(screen.queryByLabelText('Cron expression')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);
    expect(screen.getByText('Prompt is required.')).toBeTruthy();
    expect(screen.queryByLabelText('Cron expression')).toBeNull();

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Invalid schedule' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await waitFor(() => {
      expect(screen.getAllByText('Cron expression format is invalid.')).toHaveLength(1);
      expect(screen.queryByText('Prompt is required.')).toBeNull();
      expect(screen.getByLabelText('Cron expression')).toBeTruthy();
      expect(apiMock.cronCreate).not.toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 8 * * *');
    expect(screen.queryByText('Cron expression format is invalid.')).toBeNull();
  });

  it('keeps an invalid recurring expression after temporarily switching to one-time', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '30 8 *' } });
    expect(screen.getByText('Cron expression format is invalid.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));

    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('daily');
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 8 *');
    expect(screen.getByText('Cron expression format is invalid.')).toBeTruthy();
  });

  it('keeps separate one-time and recurring drafts while creating a task', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
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
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 8 * * 1');
  });

  it('collapses and restores the linked cron expression without changing it', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '08:30' } });
    const toggle = screen.getByRole('button', { name: /Advanced Cron expression/ });

    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 8 * * *');
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('Cron expression')).toBeNull();
    fireEvent.click(toggle);
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 8 * * *');
  });

  it('keeps linked input when the create API rejects the schedule', async () => {
    setup([]);
    apiMock.cronCreate.mockResolvedValue(jsonResponse({ error: 'No future run time.' }, false));

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep this input' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 8 28 2 *' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await screen.findByText('No future run time.');
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('0 8 28 2 *');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep this input');
  });

  it('validates required create fields before calling the API', async () => {
    setup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByText('Create Cron Task');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await screen.findByText('Prompt is required.');
    expect(apiMock.cronCreate).not.toHaveBeenCalled();
  });

  it('shows a specific validation error for an invalid timezone', async () => {
    setup([makeJob({ id: 'job-invalid-timezone', prompt: 'Timezone task', revision: 1 })]);

    await screen.findByText('Timezone task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Not/AZone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Timezone is invalid.')).toBeTruthy();
    expect(apiMock.cronUpdate).not.toHaveBeenCalled();
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

    await screen.findByText(`${mode} task`);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await screen.findByText('Edit Cron Task');
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('/project/general');
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe(mode);
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe(time);
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe(expression);
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

    await screen.findByText('Weekly report');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated weekly report' } });
    fireEvent.change(screen.getByLabelText('Day of week'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-edit', {
        message: 'Updated weekly report',
        projectKey: '/project/general',
        expectedRevision: 7,
        schedule: { type: 'cron', expression: '45 10 * * 5', timezone: 'Asia/Shanghai' },
        timezone: 'Asia/Shanghai',
      });
      expect(apiMock.cronCreate).not.toHaveBeenCalled();
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
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

    await screen.findByText('One-time task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
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

    await screen.findByText('Precise one-time task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
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

    await screen.findByText('Convert to recurring');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));

    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('daily');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('10:30');
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 10 * * *');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-once-to-cron', {
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

    await screen.findByText('Convert to one-time');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));

    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-01-15');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('13:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-cron-to-once', {
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

    await screen.findByText('Convert across date boundary');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));

    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-01-14');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('18:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-cron-to-once-date-boundary', {
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
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

    await screen.findByText('Convert fallback task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));

    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-11-01');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('01:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith('job-cron-to-once-fallback', {
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

    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await screen.findByRole('option', { name: 'General' });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'DST gap task' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '/project/general' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-08' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '02:30' } });
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Task' }).at(-1)!);

    await screen.findByText('Run time does not exist in the selected timezone.');
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

    await screen.findByText('Keep both drafts');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-20' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:15' } });

    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
    expect((screen.getByLabelText('Repeat period') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByLabelText('Day of week') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('13:30');
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('30 13 * * 1');

    fireEvent.click(screen.getByRole('button', { name: 'One-time' }));
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-01-20');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('14:15');
  });

  it('cancels editing without sending an update request', async () => {
    setup([makeJob({ id: 'job-cancel-edit', prompt: 'Keep original task' })]);

    await screen.findByText('Keep original task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Unsaved change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await screen.findByText('Keep original task');
    expect(screen.queryByText('Edit Cron Task')).toBeNull();
    expect(apiMock.cronUpdate).not.toHaveBeenCalled();
  });

  it('shows the original workspace when it is no longer in the project list', async () => {
    setup([makeJob({ id: 'job-removed-project', projectKey: '/project/removed', prompt: 'Removed workspace task' })]);

    await screen.findByText('Removed workspace task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const workspace = screen.getByLabelText('Workspace') as HTMLSelectElement;
    expect(workspace.value).toBe('/project/removed');
    expect(workspace.disabled).toBe(true);
    expect(workspace.selectedOptions[0]?.textContent).toBe('/project/removed');
  });

  it('keeps edit input and shows a localized message after a version conflict', async () => {
    setup([makeJob({ id: 'job-conflict', prompt: 'Original task', revision: 8 })]);
    apiMock.cronUpdate.mockResolvedValueOnce(jsonResponse({ code: 'cron_conflict' }, false, 409));

    await screen.findByText('Original task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep this edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await screen.findByText('This task has changed. Refresh the list and edit it again.');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep this edit');
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('keeps edit input and shows a localized message when the task starts running', async () => {
    setup([makeJob({ id: 'job-running-conflict', prompt: 'Original running task', revision: 5 })]);
    apiMock.cronUpdate.mockResolvedValueOnce(jsonResponse({ code: 'cron_running' }, false, 409));

    await screen.findByText('Original running task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep running conflict edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await screen.findByText('Stop the running task before saving changes.');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep running conflict edit');
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('keeps edit input and shows a localized message after a general save failure', async () => {
    setup([makeJob({ id: 'job-save-failure', prompt: 'Original failure task', revision: 6 })]);
    apiMock.cronUpdate.mockResolvedValueOnce(jsonResponse({ error: 'Storage unavailable' }, false, 500));

    await screen.findByText('Original failure task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Keep failed edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await screen.findByText('Failed to save cron task changes.');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Keep failed edit');
    expect(screen.queryByText('Storage unavailable')).toBeNull();
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
  });

  it('disables editing for running, unsupported, and incomplete tasks with explanations', async () => {
    setup([
      makeJob({ id: 'job-running-edit', prompt: 'Running task', status: 'running' }),
      makeJob({
        id: 'job-complex-edit',
        prompt: 'Complex task',
        cron: '*/5 * * * *',
        schedule: { type: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
      }),
      makeJob({ id: 'job-incomplete-edit', prompt: 'Incomplete task', revision: undefined }),
    ]);

    await screen.findByText('Running task');
    expect((within(screen.getByTitle('Stop the running task before editing.')).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByTitle('This task uses a schedule that cannot be edited on this page.')).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByTitle('This task is missing the details required for editing.')).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
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

  it('opens the delete confirmation and cancels without deleting', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await screen.findByText('Delete this job');
    fireEvent.click(screen.getByTitle('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    expect(within(dialog).getByText('Delete this job')).toBeTruthy();
    expect(apiMock.cronDelete).not.toHaveBeenCalled();

    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.keyDown(cancelButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmButton);
    fireEvent.keyDown(confirmButton, { key: 'Tab' });
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.click(cancelButton);

    expect(screen.queryByRole('dialog', { name: 'Delete cron task?' })).toBeNull();
    expect(apiMock.cronDelete).not.toHaveBeenCalled();
  });

  it('shows only a short preview of a long prompt in the delete confirmation', async () => {
    const longPrompt = 'Long cron task prompt '.repeat(30);
    const preview = `${longPrompt.slice(0, 160)}…`;
    setup([makeJob({ id: 'job-delete', prompt: longPrompt })]);

    fireEvent.click(await screen.findByTitle('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    const promptPreview = within(dialog).getByText(preview);
    expect(promptPreview.className).toContain('line-clamp-2');
    expect(dialog.textContent).not.toContain(longPrompt);
  });

  it('closes the delete confirmation with Escape without deleting', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await screen.findByText('Delete this job');
    fireEvent.click(screen.getByTitle('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Delete cron task?' })).toBeNull();
    expect(apiMock.cronDelete).not.toHaveBeenCalled();
  });

  it('deletes a cron job after confirmation and refreshes', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);

    await screen.findByText('Delete this job');
    fireEvent.click(screen.getByTitle('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    expect(apiMock.cronDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(apiMock.cronDelete).toHaveBeenCalledWith('job-delete');
      expect(apiMock.cronDelete).toHaveBeenCalledTimes(1);
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole('dialog', { name: 'Delete cron task?' })).toBeNull();
  });

  it('keeps the delete confirmation open when deletion fails', async () => {
    setup([makeJob({ id: 'job-delete', prompt: 'Delete this job' })]);
    apiMock.cronDelete.mockResolvedValueOnce(jsonResponse({ error: 'Delete failed' }, false));

    await screen.findByText('Delete this job');
    fireEvent.click(screen.getByTitle('Delete'));

    const dialog = screen.getByRole('dialog', { name: 'Delete cron task?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('Delete failed');
    expect(screen.getByRole('dialog', { name: 'Delete cron task?' })).toBeTruthy();
    expect(screen.getAllByText('Delete this job').length).toBeGreaterThan(0);
    expect(apiMock.allCronJobs).toHaveBeenCalledTimes(1);
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
