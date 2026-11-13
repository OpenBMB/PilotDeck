import { isValidCronExpression } from '../../../../../src/cron/runtime/CronSchedule';
import type { CronJobOverview, CronJobSchedule } from '../../../types/app';
import { parseSimpleCronExpression } from '../utils/cronSchedule';

export type CronTranslate = (key: string, options?: Record<string, any>) => string;

export function formatCronTime(value: string | undefined, timezone?: string | null, dateStyle: 'short' | 'medium' = 'short') {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle, timeStyle: 'short', timeZone: timezone || undefined });
}

export function cronScheduleLabel(schedule: CronJobSchedule | undefined, timezone: string | null | undefined, t: CronTranslate): string {
  if (!schedule) return t('cron.workspace.custom', { defaultValue: 'Custom schedule' });
  if (schedule.type === 'once') return t('cron.workspace.onceAt', { defaultValue: 'Once · {{time}}', time: formatCronTime(schedule.runAt, timezone) });
  if (schedule.type === 'interval') return t('cron.create.plan.interval', { defaultValue: 'Every {{minutes}} minutes', minutes: schedule.everySeconds / 60 });
  if (schedule.type === 'monthly') {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + schedule.weekday)));
    const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
    return t('cron.workspace.monthlyWeekday', { defaultValue: '{{ordinal}} {{weekday}} of each month · {{time}}', ordinal: t(`cron.ordinals.${schedule.ordinal}`), weekday, time });
  }
  const simple = parseSimpleCronExpression(schedule.expression);
  if (!simple) return schedule.expression;
  if (simple.mode === 'daily') return t('cron.create.plan.daily', { defaultValue: 'Daily at {{time}}', time: simple.time });
  if (simple.mode === 'weekly') {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + simple.weekday)));
    return t('cron.create.plan.weekly', { defaultValue: 'Every {{weekday}} at {{time}}', weekday, time: simple.time });
  }
  if (simple.mode === 'monthly') return t('cron.create.plan.monthly', { defaultValue: 'Monthly on day {{day}} at {{time}}', day: simple.dayOfMonth, time: simple.time });
  return t('cron.create.plan.yearly', { defaultValue: 'Yearly on {{month}}/{{day}} at {{time}}', month: simple.monthOfYear, day: simple.dayOfMonth, time: simple.time });
}

export function taskNeedsAttention(job: CronJobOverview) {
  return ['failed', 'missed'].includes(job.status) || (job.lastRun?.outcome && job.lastRun.outcome !== 'completed') || job.lastRun?.deliveryStatus === 'failed';
}

export function taskEditDisabled(job: CronJobOverview): 'running' | 'unsupported' | 'incomplete' | null {
  if (job.status === 'running') return 'running';
  if (!job.projectKey || !job.schedule || !Number.isSafeInteger(job.revision)) return 'incomplete';
  if (!['once', 'cron', 'interval', 'monthly'].includes(job.schedule.type)) return 'unsupported';
  if (job.schedule.type === 'cron' && !isValidCronExpression(job.schedule.expression)) return 'unsupported';
  if (job.schedule.type === 'once' && !Number.isFinite(Date.parse(job.schedule.runAt))) return 'unsupported';
  return null;
}
