import { useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, CalendarClock, Clock, Loader2, Pencil, PlusCircle } from 'lucide-react';
import type { CronJobOverview, CronJobSchedule, Project } from '../../../types/app';
import { api } from '../../../utils/api';
import { cn } from '../../../lib/utils.js';
import DateTimeField from '../../ui/DateTimeField';
import { isValidCronExpression } from '../../../../../src/cron/runtime/CronSchedule';
import CronExecutionFields, { type CronExecutionDraft } from './CronExecutionFields';
import CronTaskDialog from './CronTaskDialog';
import { buildSimpleCronExpression, getYearlyMonthDayCount, parseSimpleCronExpression, type SimpleCronSchedule, type SimpleRecurrenceMode } from '../utils/cronSchedule';

const HOUR_MS = 60 * 60 * 1000;
const TIMEZONE_OFFSET_SAMPLE_HOURS = [-36, -24, -12, 0, 12, 24, 36] as const;

type RecurrenceMode = SimpleRecurrenceMode | 'custom' | 'interval' | 'monthly-weekday';
type ScheduleKind = 'once' | 'cron';

type CronFormValues = {
  message: string;
  projectKey: string;
  scheduleKind: ScheduleKind;
  scheduleDate: string;
  scheduleTime: string;
  timezone: string;
  recurrenceMode: RecurrenceMode;
  weekday: number;
  dayOfMonth: number;
  monthOfYear: number;
  customExpression: string;
};

type OnceScheduleDraft = Pick<CronFormValues, 'scheduleDate' | 'scheduleTime'>;
type RecurringScheduleDraft = Pick<CronFormValues, 'scheduleTime' | 'recurrenceMode' | 'weekday' | 'dayOfMonth' | 'monthOfYear'>;

function getSimpleCronSchedule(draft: RecurringScheduleDraft): SimpleCronSchedule {
  switch (draft.recurrenceMode) {
    case 'daily':
      return { mode: 'daily', time: draft.scheduleTime };
    case 'weekly':
      return { mode: 'weekly', time: draft.scheduleTime, weekday: draft.weekday };
    case 'monthly':
      return { mode: 'monthly', time: draft.scheduleTime, dayOfMonth: draft.dayOfMonth };
    case 'yearly':
      return { mode: 'yearly', time: draft.scheduleTime, dayOfMonth: draft.dayOfMonth, monthOfYear: draft.monthOfYear };
    default: throw new Error('A custom rule cannot be converted to a basic rule.');
  }
}

function buildSimpleExpression(draft: RecurringScheduleDraft): string {
  try {
    return buildSimpleCronExpression(getSimpleCronSchedule(draft));
  } catch {
    return '';
  }
}

const SIMPLE_RECURRENCE_MODES: {
  id: RecurrenceMode;
  labelKey: string;
  defaultLabel: string;
}[] = [
  { id: 'daily', labelKey: 'cron.create.schedule.daily', defaultLabel: 'Daily' },
  { id: 'weekly', labelKey: 'cron.create.schedule.weekly', defaultLabel: 'Weekly' },
  { id: 'monthly', labelKey: 'cron.create.schedule.monthly', defaultLabel: 'Monthly' },
  { id: 'yearly', labelKey: 'cron.create.schedule.yearly', defaultLabel: 'Yearly' },
  { id: 'interval', labelKey: 'cron.create.schedule.interval', defaultLabel: 'Fixed interval' },
  { id: 'monthly-weekday', labelKey: 'cron.create.schedule.monthlyWeekday', defaultLabel: 'Weekday of month' },
];

const WEEKDAY_OPTIONS = [
  { value: 1, labelKey: 'cron.create.weekdays.monday', defaultLabel: 'Monday' },
  { value: 2, labelKey: 'cron.create.weekdays.tuesday', defaultLabel: 'Tuesday' },
  { value: 3, labelKey: 'cron.create.weekdays.wednesday', defaultLabel: 'Wednesday' },
  { value: 4, labelKey: 'cron.create.weekdays.thursday', defaultLabel: 'Thursday' },
  { value: 5, labelKey: 'cron.create.weekdays.friday', defaultLabel: 'Friday' },
  { value: 6, labelKey: 'cron.create.weekdays.saturday', defaultLabel: 'Saturday' },
  { value: 0, labelKey: 'cron.create.weekdays.sunday', defaultLabel: 'Sunday' },
] as const;

const MONTH_OPTIONS = [
  { value: 1, labelKey: 'cron.create.months.january', defaultLabel: 'January' },
  { value: 2, labelKey: 'cron.create.months.february', defaultLabel: 'February' },
  { value: 3, labelKey: 'cron.create.months.march', defaultLabel: 'March' },
  { value: 4, labelKey: 'cron.create.months.april', defaultLabel: 'April' },
  { value: 5, labelKey: 'cron.create.months.may', defaultLabel: 'May' },
  { value: 6, labelKey: 'cron.create.months.june', defaultLabel: 'June' },
  { value: 7, labelKey: 'cron.create.months.july', defaultLabel: 'July' },
  { value: 8, labelKey: 'cron.create.months.august', defaultLabel: 'August' },
  { value: 9, labelKey: 'cron.create.months.september', defaultLabel: 'September' },
  { value: 10, labelKey: 'cron.create.months.october', defaultLabel: 'October' },
  { value: 11, labelKey: 'cron.create.months.november', defaultLabel: 'November' },
  { value: 12, labelKey: 'cron.create.months.december', defaultLabel: 'December' },
] as const;

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function TimezoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const options = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone')
      : ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
    return [...new Set([getBrowserTimezone(), 'UTC', value, ...supported])].filter(Boolean);
  }, [value]);
  return <select className="pd-form-field mt-1.5" value={value} onChange={event => onChange(event.target.value)}>
    {options.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}
  </select>;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function readDateTimeInTimezone(date: Date, timezone: string): ZonedDateTimeParts | undefined {
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const values: Record<string, string> = {};
    const formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== 'literal') values[part.type] = part.value;
    }
    const result = {
      year: Number.parseInt(values.year, 10),
      month: Number.parseInt(values.month, 10),
      day: Number.parseInt(values.day, 10),
      hour: Number.parseInt(values.hour, 10),
      minute: Number.parseInt(values.minute, 10),
    };
    return Object.values(result).every(Number.isInteger) ? result : undefined;
  } catch {
    return undefined;
  }
}

function formatDateTimeInTimezone(date: Date, timezone: string): string {
  const parts = readDateTimeInTimezone(date, timezone);
  if (!parts) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    parts.year,
    '-',
    pad(parts.month),
    '-',
    pad(parts.day),
    'T',
    pad(parts.hour),
    ':',
    pad(parts.minute),
  ].join('');
}

function formatDateInTimezone(date: Date, timezone: string): string {
  return formatDateTimeInTimezone(date, timezone).slice(0, 10);
}

function formatTimeInTimezone(date: Date, timezone: string): string {
  return formatDateTimeInTimezone(date, timezone).slice(11, 16);
}

function parseWallTime(scheduleDate: string, scheduleTime: string): ZonedDateTimeParts | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scheduleDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(scheduleTime);
  if (!dateMatch || !timeMatch) return undefined;

  const parts = {
    year: Number.parseInt(dateMatch[1], 10),
    month: Number.parseInt(dateMatch[2], 10),
    day: Number.parseInt(dateMatch[3], 10),
    hour: Number.parseInt(timeMatch[1], 10),
    minute: Number.parseInt(timeMatch[2], 10),
  };
  const normalized = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (normalized.getUTCFullYear() !== parts.year
    || normalized.getUTCMonth() + 1 !== parts.month
    || normalized.getUTCDate() !== parts.day
    || normalized.getUTCHours() !== parts.hour
    || normalized.getUTCMinutes() !== parts.minute) {
    return undefined;
  }
  return parts;
}

function sameWallTime(left: ZonedDateTimeParts, right: ZonedDateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

function wallTimeEpoch(parts: ZonedDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function timezoneOffsetAt(epochMs: number, timezone: string): number | undefined {
  const instant = new Date(epochMs);
  const zoned = readDateTimeInTimezone(instant, timezone);
  if (!zoned) return undefined;
  return wallTimeEpoch(zoned) - epochMs;
}

function resolveWallTimeInTimezone(
  scheduleDate: string,
  scheduleTime: string,
  timezone: string,
  referenceEpochMs: number,
): string | undefined {
  if (!isValidTimezone(timezone)) return undefined;
  const requested = parseWallTime(scheduleDate, scheduleTime);
  if (!requested) return undefined;

  const requestedEpoch = wallTimeEpoch(requested);
  const possibleOffsets = new Set<number>();
  for (const hours of TIMEZONE_OFFSET_SAMPLE_HOURS) {
    const offset = timezoneOffsetAt(requestedEpoch + hours * HOUR_MS, timezone);
    if (offset !== undefined) possibleOffsets.add(offset);
  }

  const candidates: number[] = [];
  for (const offset of possibleOffsets) {
    const candidateEpoch = requestedEpoch - offset;
    const candidate = readDateTimeInTimezone(new Date(candidateEpoch), timezone);
    if (candidate && sameWallTime(candidate, requested)) candidates.push(candidateEpoch);
  }
  if (candidates.length === 0) return undefined;

  const orderedCandidates = candidates.sort((left, right) => left - right);
  const selectedCandidate = orderedCandidates.find((candidate) => candidate > referenceEpochMs)
    ?? orderedCandidates[0];

  // During DST fallback, prefer the earliest occurrence that is still in the
  // future. If every occurrence has passed, return the earliest one so the
  // caller can report the normal "must be in the future" validation error.
  return new Date(selectedCandidate).toISOString();
}

function resolveOneTimeRunAt(
  editingJob: CronJobOverview | null,
  scheduleDate: string,
  scheduleTime: string,
  timezone: string,
): string | undefined {
  if (editingJob?.schedule?.type === 'once') {
    const original = new Date(editingJob.schedule.runAt);
    if (!Number.isNaN(original.getTime())
      && formatDateInTimezone(original, timezone) === scheduleDate
      && formatTimeInTimezone(original, timezone) === scheduleTime) {
      return editingJob.schedule.runAt;
    }
  }

  return resolveWallTimeInTimezone(scheduleDate, scheduleTime, timezone, Date.now());
}

function getDefaultFormValues(): CronFormValues {
  const defaultRunAt = new Date(Date.now() + 60 * 60 * 1000);
  const timezone = getBrowserTimezone();
  const scheduleTime = formatTimeInTimezone(defaultRunAt, timezone);
  return {
    message: '',
    projectKey: '',
    scheduleKind: 'once',
    scheduleDate: formatDateInTimezone(defaultRunAt, timezone),
    scheduleTime,
    timezone,
    recurrenceMode: 'daily',
    weekday: defaultRunAt.getDay(),
    dayOfMonth: defaultRunAt.getDate(),
    monthOfYear: defaultRunAt.getMonth() + 1,
    customExpression: '',
  };
}

function getFormValues(job: CronJobOverview | null): CronFormValues {
  const defaults = getDefaultFormValues();
  if (!job?.schedule || !job.projectKey) return defaults;

  const timezone = job.timezone?.trim()
    || (job.schedule.type === 'cron' ? job.schedule.timezone?.trim() : '')
    || defaults.timezone;
  if (job.schedule.type === 'once') {
    const runAt = new Date(job.schedule.runAt);
    if (Number.isNaN(runAt.getTime())) return defaults;
    const displayTimezone = isValidTimezone(timezone) ? timezone : defaults.timezone;
    const scheduleTime = formatTimeInTimezone(runAt, displayTimezone);
    return {
      ...defaults,
      message: job.prompt,
      projectKey: job.projectKey,
      scheduleKind: 'once',
      scheduleDate: formatDateInTimezone(runAt, displayTimezone),
      scheduleTime,
      timezone,
      customExpression: '',
    };
  }

  if (job.schedule.type === 'interval') return { ...defaults, message: job.prompt, projectKey: job.projectKey, timezone, scheduleKind: 'cron', recurrenceMode: 'interval' };
  if (job.schedule.type === 'monthly') return { ...defaults, message: job.prompt, projectKey: job.projectKey, timezone, scheduleKind: 'cron', recurrenceMode: 'monthly-weekday', weekday: job.schedule.weekday, scheduleTime: `${String(job.schedule.hour).padStart(2, '0')}:${String(job.schedule.minute).padStart(2, '0')}` };
  const parsed = parseSimpleCronExpression(job.schedule.expression);
  if (!parsed) return { ...defaults, message: job.prompt, projectKey: job.projectKey, timezone, scheduleKind: 'cron', recurrenceMode: 'custom', customExpression: job.schedule.expression };
  const values: CronFormValues = {
    ...defaults,
    message: job.prompt,
    projectKey: job.projectKey,
    scheduleKind: 'cron',
    scheduleTime: parsed.time,
    timezone,
    recurrenceMode: parsed.mode,
    customExpression: '',
  };
  if (parsed.mode === 'weekly') {
    values.weekday = parsed.weekday;
  } else if (parsed.mode === 'monthly') {
    values.dayOfMonth = parsed.dayOfMonth;
  } else if (parsed.mode === 'yearly') {
    values.dayOfMonth = parsed.dayOfMonth;
    values.monthOfYear = parsed.monthOfYear;
  }
  return values;
}

function addCalendarDay(scheduleDate: string): string {
  const [year, month, day] = scheduleDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function getNextFutureDateForTime(time: string, timezone: string): string {
  const now = new Date();
  const resolvedTimezone = isValidTimezone(timezone) ? timezone : getBrowserTimezone();
  const today = formatDateInTimezone(now, resolvedTimezone);
  const candidate = resolveWallTimeInTimezone(today, time, resolvedTimezone, now.getTime());
  if (!candidate || Date.parse(candidate) <= now.getTime()) return addCalendarDay(today);
  return today;
}

export default function CronTaskEditor({
  t,
  projects,
  editingJob,
  onCompleted,
  onCancel,
}: {
  t: (key: string, opts?: Record<string, string>) => string;
  projects: Project[];
  editingJob: CronJobOverview | null;
  onCompleted: (taskId?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const initialValues = useMemo(() => getFormValues(editingJob), [editingJob]);
  const isEditing = editingJob !== null;
  const [message, setMessage] = useState(initialValues.message);
  const [execution, setExecution] = useState<CronExecutionDraft>({
    reminderTiming: editingJob ? editingJob.reminderTiming || 'result' : undefined,
    notificationPolicy: editingJob?.notificationPolicy || 'all', mode: editingJob?.mode || 'default',
    workspaceMode: editingJob?.workspaceMode || 'local', modelSelection: editingJob?.modelSelection,
  });
  const [intervalMinutes, setIntervalMinutes] = useState(editingJob?.schedule?.type === 'interval' ? editingJob.schedule.everySeconds / 60 : 60);
  const [ordinal, setOrdinal] = useState<number>(editingJob?.schedule?.type === 'monthly' ? editingJob.schedule.ordinal : 1);
  const [intervalAnchor] = useState(() => editingJob?.schedule?.type === 'interval' ? editingJob.schedule.anchorAt : new Date().toISOString());
  const [projectKey, setProjectKey] = useState(initialValues.projectKey);
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(initialValues.scheduleKind);
  const [onceDraft, setOnceDraft] = useState<OnceScheduleDraft>({
    scheduleDate: initialValues.scheduleDate,
    scheduleTime: initialValues.scheduleTime,
  });
  const [recurringDraft, setRecurringDraft] = useState<RecurringScheduleDraft>({
    scheduleTime: initialValues.scheduleTime,
    recurrenceMode: initialValues.recurrenceMode,
    weekday: initialValues.weekday,
    dayOfMonth: initialValues.dayOfMonth,
    monthOfYear: initialValues.monthOfYear,
  });
  const [hasOnceDraft, setHasOnceDraft] = useState(initialValues.scheduleKind === 'once');
  const [hasRecurringDraft, setHasRecurringDraft] = useState(initialValues.scheduleKind === 'cron');
  const [timezone, setTimezone] = useState(initialValues.timezone);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const projectOptionExists = projects.some((project) => (project.fullPath || project.name) === projectKey);
  const { scheduleTime, recurrenceMode, weekday, dayOfMonth, monthOfYear } = recurringDraft;

  const expression = recurrenceMode === 'custom' ? initialValues.customExpression : buildSimpleExpression(recurringDraft);
  const expressionIsValid = isValidCronExpression(expression);

  const updateRecurringDraft = (updates: Partial<RecurringScheduleDraft>) => {
    setRecurringDraft(current => ({ ...current, ...updates }));
    setHasRecurringDraft(true);
  };

  const scheduleNotice = recurrenceMode === 'monthly' && dayOfMonth >= 29
    ? t('cron.create.help.monthlyDateMayBeSkipped', { defaultValue: 'Months without this date will not trigger the task.' })
    : recurrenceMode === 'yearly' && monthOfYear === 2 && dayOfMonth === 29
      ? t('cron.create.help.yearlyLeapDay', { defaultValue: 'This task will only trigger in leap years.' })
      : null;

  const resetForm = () => {
    const defaults = getDefaultFormValues();
    setMessage(defaults.message);
    setProjectKey(defaults.projectKey);
    setScheduleKind(defaults.scheduleKind);
    setOnceDraft({ scheduleDate: defaults.scheduleDate, scheduleTime: defaults.scheduleTime });
    setRecurringDraft({
      scheduleTime: defaults.scheduleTime,
      recurrenceMode: defaults.recurrenceMode,
      weekday: defaults.weekday,
      dayOfMonth: defaults.dayOfMonth,
      monthOfYear: defaults.monthOfYear,
    });
    setHasOnceDraft(true);
    setHasRecurringDraft(false);
    setTimezone(defaults.timezone);
  };

  const handleScheduleKindChange = (kind: ScheduleKind) => {
    if (kind === scheduleKind) return;
    setFormError(null);
    if (kind === 'cron' && !hasRecurringDraft) {
      const nextDraft: RecurringScheduleDraft = {
        ...recurringDraft,
        scheduleTime: onceDraft.scheduleTime,
        recurrenceMode: 'daily',
      };
      setRecurringDraft(nextDraft);
      setHasRecurringDraft(true);
    } else if (kind === 'once' && !hasOnceDraft) {
      setOnceDraft({
        scheduleDate: getNextFutureDateForTime(recurringDraft.scheduleTime, timezone.trim()),
        scheduleTime: recurringDraft.scheduleTime,
      });
      setHasOnceDraft(true);
    }
    setScheduleKind(kind);
  };

  const validate = () => {
    if (!message.trim()) {
      return t('cron.create.validation.messageRequired', { defaultValue: 'Prompt is required.' });
    }
    if (!projectKey) {
      return t('cron.create.validation.workspaceRequired', { defaultValue: 'Workspace is required.' });
    }
    if (scheduleKind === 'once' && !onceDraft.scheduleTime) {
      return t('cron.create.validation.timeRequired', { defaultValue: 'Time is required.' });
    }
    if (!timezone.trim()) {
      return t('cron.create.validation.timezoneRequired', { defaultValue: 'Timezone is required.' });
    }
    if (!isValidTimezone(timezone.trim())) {
      return t('cron.create.validation.timezoneInvalid', { defaultValue: 'Timezone is invalid.' });
    }
    if (scheduleKind === 'once') {
      if (!onceDraft.scheduleDate) {
        return t('cron.create.validation.dateRequired', { defaultValue: 'Date is required.' });
      }
      const runAt = resolveOneTimeRunAt(
        editingJob,
        onceDraft.scheduleDate,
        onceDraft.scheduleTime,
        timezone.trim(),
      );
      if (!runAt) {
        return t('cron.create.validation.runAtInvalid', { defaultValue: 'Run time does not exist in the selected timezone.' });
      }
      if (Date.parse(runAt) <= Date.now()) {
        return t('cron.create.validation.runAtFuture', { defaultValue: 'Run time must be in the future.' });
      }
    } else {
      if (!['interval', 'custom'].includes(recurrenceMode) && !scheduleTime) {
        return t('cron.create.validation.timeRequired', { defaultValue: 'Time is required.' });
      }
      if (!['interval', 'monthly-weekday'].includes(recurrenceMode) && !expressionIsValid) {
        return t('cron.create.validation.expressionInvalid', { defaultValue: 'Cron expression format is invalid.' });
      }
    }
    if (scheduleKind === 'cron' && recurrenceMode === 'interval' && (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1)) return t('cron.create.validation.interval', { defaultValue: 'Enter a positive number of minutes.' });
    return null;
  };

  const buildSchedule = (): CronJobSchedule | null => {
    if (scheduleKind === 'once') {
      const runAt = resolveOneTimeRunAt(editingJob, onceDraft.scheduleDate, onceDraft.scheduleTime, timezone.trim());
      return runAt ? { type: 'once', runAt } : null;
    }
    if (recurrenceMode === 'interval') return { type: 'interval', everySeconds: intervalMinutes * 60,
      anchorAt: intervalAnchor };
    if (recurrenceMode === 'monthly-weekday') {
      const [hour, minute] = scheduleTime.split(':').map(Number);
      return { type: 'monthly', ordinal: ordinal as 1 | 2 | 3 | 4 | -1, weekday, hour, minute, timezone: timezone.trim() };
    }
    return { type: 'cron', expression, timezone: timezone.trim() };
  };
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSuccess(null);
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const schedule = buildSchedule();
      if (!schedule) return;
      const payload = {
        message: message.trim(),
        projectKey,
        workspaceCwd: projects.find(project => (project.fullPath || project.name) === projectKey)?.workspaceCwd || projectKey,
        ...execution,
        ...(editingJob ? { modelSelection: execution.modelSelection ?? null } : {}),
        schedule,
        timezone: timezone.trim() || undefined,
      };
      const response = editingJob
        ? await api.cronUpdate(editingJob.id, { ...payload, expectedRevision: editingJob.revision })
        : await api.cronCreate(payload);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (editingJob) {
          const conflictMarker = `${body.code || ''} ${body.error || ''}`.toLowerCase();
          if (response.status === 409 && conflictMarker.includes('running')) {
            setFormError(t('cron.edit.errors.running', { defaultValue: 'Stop the running task before saving changes.' }));
          } else if (response.status === 409) {
            setFormError(t('cron.edit.errors.conflict', { defaultValue: 'This task has changed. Refresh the list and edit it again.' }));
          } else {
            setFormError(t('cron.edit.errors.saveFailed', { defaultValue: 'Failed to save cron task changes.' }));
          }
          return;
        }
        if (body.code === 'cron_project_unavailable') throw new Error(t('cron.create.validation.projectUnavailable', { defaultValue: 'This workspace is unavailable. Select an existing project and try again.' }));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (!editingJob) {
        resetForm();
        setSuccess(t('cron.create.success', { defaultValue: 'Cron task created.' }));
      }
      const result = await response.json();
      await onCompleted(result.task?.taskId);
    } catch (caught) {
      setFormError(editingJob
        ? t('cron.edit.errors.saveFailed', { defaultValue: 'Failed to save cron task changes.' })
        : caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CronTaskDialog title={isEditing ? t('cron.edit.title', { defaultValue: 'Edit scheduled task' }) : t('cron.create.title', { defaultValue: 'New scheduled task' })} busy={submitting} onClose={onCancel}>
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="cron-editor-form"
      >
        <div className="cron-editor-body">
        {formError ? (
          <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xxs text-red-600 dark:bg-red-950/40 dark:text-red-300">
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{formError}</span>
          </div>
        ) : success ? (
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-xxs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            {success}
          </div>
        ) : null}

        <label className="block">
          <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
            {t('cron.create.fields.prompt', { defaultValue: 'Prompt' })}
          </span>
          <textarea
            value={message}
            onChange={(event) => { setMessage(event.target.value); setFormError(null); }}
            rows={3}
            className="pd-form-field mt-1.5"
            placeholder={t('cron.create.placeholders.prompt', { defaultValue: 'Describe what PilotDeck should do when this task runs.' })}
          />
        </label>

        <label className="block">
          <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
            {t('cron.create.fields.workspace', { defaultValue: 'Workspace' })}
          </span>
          <select
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            disabled={isEditing}
            className="pd-form-field mt-1.5"
          >
            <option value="">{t('cron.create.placeholders.workspace', { defaultValue: 'Select a workspace' })}</option>
            {isEditing && projectKey && !projectOptionExists ? <option value={projectKey}>{projectKey}</option> : null}
            {projects.map((project) => (
              <option key={project.fullPath || project.name} value={project.fullPath || project.name}>
                {project.displayName || project.name}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2.5">
          <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
            {t('cron.create.fields.scheduleType', { defaultValue: 'Schedule Type' })}
          </span>
          <div className="flex w-fit rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
            {(['once', 'cron'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => handleScheduleKindChange(kind)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded px-3 text-[12px] font-medium transition-colors',
                  scheduleKind === kind
                    ? 'bg-white text-[var(--pd-accent-strong,#6554c0)] shadow-sm dark:bg-neutral-800'
                    : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100',
                )}
              >
                {kind === 'once' ? <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />}
                {kind === 'once'
                  ? t('cron.create.schedule.once', { defaultValue: 'One-time' })
                  : t('cron.create.schedule.cron', { defaultValue: 'Recurring' })}
              </button>
            ))}
          </div>
        </div>

        {scheduleKind === 'once' ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('cron.create.fields.date', { defaultValue: 'Date' })}
              </span>
              <DateTimeField
                type="date"
                aria-label={t("cron.create.fields.date")}
                value={onceDraft.scheduleDate}
                min={formatDateInTimezone(
                  new Date(),
                  isValidTimezone(timezone.trim()) ? timezone.trim() : getBrowserTimezone(),
                )}
                onValueChange={(value) => {
                  setOnceDraft((current) => ({ ...current, scheduleDate: value }));
                  setHasOnceDraft(true);
                }}
                className="pd-form-field mt-1.5"
              />
            </label>
            <label className="block">
              <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('cron.create.fields.time', { defaultValue: 'Time' })}
              </span>
              <DateTimeField
                type="time"
                aria-label={t("cron.create.fields.time")}
                value={onceDraft.scheduleTime}
                onValueChange={(value) => {
                  setOnceDraft((current) => ({ ...current, scheduleTime: value }));
                  setHasOnceDraft(true);
                }}
                className="pd-form-field mt-1.5"
              />
            </label>
            <label className="block">
              <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('cron.create.fields.timezone', { defaultValue: 'Timezone' })}
              </span>
              <TimezoneSelect value={timezone} onChange={setTimezone} />
            </label>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block min-w-0">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.repeatPeriod', { defaultValue: 'Repeat period' })}
                </span>
                <select
                  value={recurrenceMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as RecurrenceMode;
                    updateRecurringDraft({
                      recurrenceMode: nextMode,
                      dayOfMonth: nextMode === 'yearly' ? Math.min(dayOfMonth, getYearlyMonthDayCount(monthOfYear)) : dayOfMonth,
                    });
                  }}
                  className="pd-form-field mt-1.5"
                >
                  {recurrenceMode === 'custom' && <option value="custom" disabled>{t('cron.create.schedule.existing', { defaultValue: 'Existing schedule' })}</option>}
                  {SIMPLE_RECURRENCE_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {t(mode.labelKey, { defaultValue: mode.defaultLabel })}
                    </option>
                  ))}
                </select>
              </label>

              <div className="min-w-0" hidden={recurrenceMode === 'custom'}>
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.executionDay', { defaultValue: 'Execution day' })}
                </span>
                {recurrenceMode === 'daily' ? (
                  <div className="mt-1.5 flex h-9 items-center rounded-md border border-neutral-200 bg-neutral-50 px-3 text-[13px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                    {t('cron.create.options.everyDay', { defaultValue: 'Every day' })}
                  </div>
                ) : recurrenceMode === 'interval' ? (
                  <label className="block"><span className="sr-only">{t('cron.create.fields.intervalMinutes', { defaultValue: 'Interval in minutes' })}</span><input className="pd-form-field mt-1.5" type="number" min="1" step="1" value={intervalMinutes} onChange={event => setIntervalMinutes(Number(event.target.value))} /></label>
                ) : recurrenceMode === 'monthly-weekday' ? (
                  <div className="mt-1.5 flex gap-2"><select aria-label={t('cron.create.fields.ordinal', { defaultValue: 'Week of month' })} className="pd-form-field" value={ordinal} onChange={event => setOrdinal(Number(event.target.value))}>
                    {[1, 2, 3, 4, -1].map(value => <option key={value} value={value}>{t(`cron.ordinals.${value}`, { defaultValue: String(value) })}</option>)}
                  </select><select aria-label={t('cron.create.fields.weekday', { defaultValue: 'Day of week' })} className="pd-form-field" value={weekday} onChange={event => updateRecurringDraft({ weekday: Number(event.target.value) })}>
                    {WEEKDAY_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.labelKey, { defaultValue: option.defaultLabel })}</option>)}
                  </select></div>
                ) : recurrenceMode === 'weekly' ? (
                  <select
                    aria-label={t('cron.create.fields.weekday', { defaultValue: 'Day of week' })}
                    value={weekday}
                    onChange={(event) => updateRecurringDraft({ weekday: Number(event.target.value) })}
                    className="pd-form-field mt-1.5"
                  >
                    {WEEKDAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey, { defaultValue: option.defaultLabel })}
                      </option>
                    ))}
                  </select>
                ) : recurrenceMode === 'monthly' ? (
                  <select
                    aria-label={t('cron.create.fields.monthDay', { defaultValue: 'Day of month' })}
                    value={dayOfMonth}
                    onChange={(event) => updateRecurringDraft({ dayOfMonth: Number(event.target.value) })}
                    className="pd-form-field mt-1.5"
                  >
                    {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>{day}</option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <select
                      aria-label={t('cron.create.fields.month', { defaultValue: 'Month' })}
                      value={monthOfYear}
                      onChange={(event) => {
                        const nextMonth = Number(event.target.value);
                        updateRecurringDraft({
                          monthOfYear: nextMonth,
                          dayOfMonth: Math.min(dayOfMonth, getYearlyMonthDayCount(nextMonth)),
                        });
                      }}
                      className="pd-form-field"
                    >
                      {MONTH_OPTIONS.map((month) => (
                        <option key={month.value} value={month.value}>
                          {t(month.labelKey, { defaultValue: month.defaultLabel })}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t('cron.create.fields.monthDay', { defaultValue: 'Day of month' })}
                      value={dayOfMonth}
                      onChange={(event) => updateRecurringDraft({ dayOfMonth: Number(event.target.value) })}
                      className="pd-form-field"
                    >
                      {Array.from({ length: getYearlyMonthDayCount(monthOfYear) }, (_, index) => index + 1).map((day) => (
                        <option key={day} value={day}>{day}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {!['interval', 'custom'].includes(recurrenceMode) && <label className="block min-w-0">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.time', { defaultValue: 'Time' })}
                </span>
                <DateTimeField
                  type="time"
                aria-label={t("cron.create.fields.time")}
                  value={scheduleTime}
                  onValueChange={(value) => updateRecurringDraft({ scheduleTime: value })}
                  className="pd-form-field mt-1.5"
                />
              </label>}

              <label className="block min-w-0">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.timezone', { defaultValue: 'Timezone' })}
                </span>
                <TimezoneSelect value={timezone} onChange={setTimezone} />
              </label>
            </div>

            {scheduleNotice ? (
              <p aria-live="polite" className="text-[12px] text-neutral-500 dark:text-neutral-400">
                {scheduleNotice}
              </p>
            ) : null}

          </div>
        )}

        <CronExecutionFields value={execution} onChange={setExecution} project={projects.find(project => (project.fullPath || project.name) === projectKey)} editing={isEditing} />
        </div>
        <footer className="cron-dialog-footer">
          {(
            <button
              type="button"
              disabled={submitting}
              onClick={onCancel}
              className="cron-button"
            >
              {t('cron.edit.actions.cancel', { defaultValue: 'Cancel' })}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="cron-button primary"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : isEditing ? <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} /> : <PlusCircle className="h-3.5 w-3.5" strokeWidth={1.75} />}
            {isEditing
              ? t('cron.edit.actions.save', { defaultValue: 'Save Changes' })
              : t('cron.create.actions.submit', { defaultValue: 'Create Task' })}
          </button>
        </footer>
      </form>
    </CronTaskDialog>
  );
}
