// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import enAlwaysOn from '../../../i18n/locales/en/alwaysOn.json';
import type { CronJobOverview } from '../../../types/app';
import CronTaskDetails from './CronTaskDetails';

const conversation = vi.hoisted(() => vi.fn());
vi.mock('./CronTaskConversation', () => ({ default: (props: { job: CronJobOverview; emptyState?: import('react').ReactNode }) => {
  conversation(props);
  return <section data-testid="shared-task-chat">{props.job.lastRun || props.job.status === 'running' ? <div data-testid="task-transcript">Saved task messages</div> : props.emptyState}<textarea aria-label="Task reply" /></section>;
} }));

const i18n = await createTestI18n();
i18n.addResourceBundle('en', 'alwaysOn', enAlwaysOn);
const pending: CronJobOverview = {
  id: 'pending-task', projectKey: '/synthetic/project', cron: '0 18 * * 5',
  status: 'scheduled', enabled: true, recurring: true, manualOnly: false,
  createdAt: '2026-11-13T08:00:00.000Z', nextRunAt: '2026-11-13T10:00:00.000Z', timezone: 'Asia/Shanghai',
  prompt: 'LONG_PRIVATE_TASK_INSTRUCTIONS\n'.repeat(150),
};
const view = (job: CronJobOverview) => <I18nextProvider i18n={i18n}><CronTaskDetails job={job} projects={[]} /></I18nextProvider>;
afterEach(() => { cleanup(); conversation.mockClear(); });

describe('task waiting view', () => {
  it('shows a fixed waiting page with the shared reply composer and without displaying long instructions', () => {
    const { container } = render(view(pending));
    expect(screen.getByRole('heading', { name: 'Waiting for the first run' })).toBeTruthy();
    expect(screen.getByText(/^Next run · /).textContent).toMatch(/18:00|6:00 PM/);
    expect(container.querySelector('[data-task-waiting="pending-task"]')).toBeTruthy();
    expect(container.textContent).not.toContain('LONG_PRIVATE_TASK_INSTRUCTIONS');
    expect(screen.queryByTestId('task-transcript')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Task reply' })).toBeTruthy();
  });

  it('switches to the conversation on first execution and retains it between recurring runs', () => {
    const { rerender } = render(view(pending));
    rerender(view({ ...pending, status: 'running' }));
    const transcript = screen.getByTestId('shared-task-chat');
    expect(screen.queryByRole('heading', { name: 'Waiting for the first run' })).toBeNull();
    const lastRun = { runId: 'first-run', taskId: pending.id, sessionKey: 'cron:pending-task', startedAt: pending.nextRunAt!, outcome: 'completed' as const };
    rerender(view({ ...pending, lastRun }));
    expect(screen.getByTestId('shared-task-chat')).toBe(transcript);
    rerender(view({ ...pending, status: 'paused', lastRun }));
    expect(screen.getByTestId('shared-task-chat')).toBe(transcript);
  });

  it('shows a paused first-time task without promising another execution time', () => {
    render(view({ ...pending, status: 'paused', enabled: false }));
    expect(screen.getByRole('heading', { name: 'Paused' })).toBeTruthy();
    expect(screen.queryByText(/^Next run · /)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Task reply' })).toBeTruthy();
  });

  it.each([undefined, 'invalid-date'])('keeps a missing or invalid next time out of the waiting page (%s)', nextRunAt => {
    render(view({ ...pending, nextRunAt }));
    expect(screen.getByRole('heading', { name: 'Waiting for the first run' })).toBeTruthy();
    expect(screen.queryByText(/^Next run · /)).toBeNull();
  });

  it.each(['completed', 'failed', 'missed'] as const)('does not disguise a %s task as never executed', status => {
    render(view({ ...pending, status }));
    expect(screen.getByTestId('shared-task-chat')).toBeTruthy();
  });

  it('preserves legacy task history when only a fired timestamp is available', () => {
    render(view({ ...pending, lastFiredAt: Date.parse('2026-11-06T10:00:00Z') }));
    expect(screen.getByTestId('shared-task-chat')).toBeTruthy();
  });
});
