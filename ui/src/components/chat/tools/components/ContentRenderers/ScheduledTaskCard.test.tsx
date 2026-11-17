import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import ScheduledTaskCard, { scheduledTaskResult } from './ScheduledTaskCard';

afterEach(cleanup);

it('renders the current cron_create result contract with a link to its saved task', () => {
  const task = { taskId: 'task-1', name: 'Daily report', timezone: 'Asia/Shanghai', nextRunAt: '2099-01-01T01:00:00Z', executionMode: 'independent' };
  render(<ScheduledTaskCard result={{ toolUseResult: { data: { task, nextRuns: [task.nextRunAt] } } }} />);
  expect(screen.getByText('Daily report')).toBeTruthy();
  expect(screen.getByRole('link').getAttribute('href')).toBe('/cron?taskId=task-1');
  expect(scheduledTaskResult({ content: JSON.stringify(task) }).task).toEqual(task);
  expect(scheduledTaskResult({ content: [{ type: 'json', value: { task } }] }).task).toEqual(task);
});

it('keeps errors visible when no task was created', () => {
  render(<ScheduledTaskCard result={{ isError: true, content: 'The schedule is invalid.' }} />);
  expect(screen.getByText('The schedule is invalid.')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
