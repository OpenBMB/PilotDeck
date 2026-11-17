import type { CronCreateSchedule } from "../protocol/schedules.js";
import { isValidCronTimezone } from "../CronTimezone.js";

export const CRON_SCHEDULE_COMPUTATION_VERSION = 3;
export function isValidCronExpression(expression: string): boolean { return Boolean(parseCronExpression(expression)); }

/** Whether the expression uses the day-field OR rule introduced in version 3. */
export function cronDayFieldsUseOr(expression: string): boolean {
  return parseCronExpression(expression)?.dayFieldsUseOr ?? false;
}

const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 366 * 24 * 60;
const DELAY_UNIT_MS: Record<"second" | "minute" | "hour" | "day", number> = {
  second: 1_000,
  minute: MINUTE_MS,
  hour: 60 * MINUTE_MS,
  day: 24 * 60 * MINUTE_MS,
};

export function computeNextRunAt(
  schedule: CronCreateSchedule,
  after: Date,
  fallbackTimezone = "UTC",
): Date | undefined {
  if (schedule.type === "once") {
    const runAt = new Date(schedule.runAt);
    return Number.isNaN(runAt.getTime()) ? undefined : runAt;
  }
  if (schedule.type === "delay") {
    const delayMs = delayToMilliseconds(schedule.amount, schedule.unit);
    return delayMs === undefined ? undefined : new Date(after.getTime() + delayMs);
  }
  if (schedule.type === "interval") {
    if (!Number.isSafeInteger(schedule.everySeconds) || schedule.everySeconds < 60) return undefined;
    const anchor = schedule.anchorAt ? Date.parse(schedule.anchorAt) : after.getTime();
    if (!Number.isFinite(anchor)) return undefined;
    const interval = schedule.everySeconds * 1_000;
    return new Date(anchor + Math.max(1, Math.floor((after.getTime() - anchor) / interval) + 1) * interval);
  }
  if (schedule.type === "monthly") {
    if (![1, 2, 3, 4, -1].includes(schedule.ordinal)
      || !Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6
      || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23
      || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59
      || !isValidCronTimezone(schedule.timezone)) return undefined;
    const formatter = createCronDateFormatter(schedule.timezone);
    let candidate = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
    for (let index = 0; index < 63 * 24 * 60; index += 1) {
      const parts = readCronDateParts(candidate, formatter);
      if (parts && parts.hour === schedule.hour && parts.minute === schedule.minute
        && parts.dayOfWeek === schedule.weekday) {
        const year = Number(new Intl.DateTimeFormat("en", { timeZone: schedule.timezone, year: "numeric" }).format(candidate));
        const lastDay = new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
        if (schedule.ordinal === -1 ? parts.dayOfMonth + 7 > lastDay
          : Math.floor((parts.dayOfMonth - 1) / 7) + 1 === schedule.ordinal) return candidate;
      }
      candidate = new Date(candidate.getTime() + MINUTE_MS);
    }
    return undefined;
  }
  return computeNextCronRunAt(schedule.expression, after, schedule.timezone ?? fallbackTimezone);
}

/** Preview uses the same evaluator as execution; no task or session is created. */
export function previewCronSchedule(schedule: CronCreateSchedule, after: Date, timezone = "UTC", count = 3): string[] {
  const result: string[] = [];
  let cursor = after;
  const normalized = schedule.type === "interval" && !schedule.anchorAt
    ? { ...schedule, anchorAt: after.toISOString() } : schedule;
  for (let index = 0; index < Math.min(10, count); index += 1) {
    const next = computeNextRunAt(normalized, cursor, timezone);
    if (!next || next.getTime() <= cursor.getTime()) break;
    result.push(next.toISOString());
    if (normalized.type === "once" || normalized.type === "delay") break;
    cursor = next;
  }
  return result;
}

export function delayToMilliseconds(
  amount: number,
  unit: "second" | "minute" | "hour" | "day",
): number | undefined {
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return amount * DELAY_UNIT_MS[unit];
}

export function computeNextCronRunAt(
  expression: string,
  after: Date,
  timezone = "UTC",
): Date | undefined {
  const parsed = parseCronExpression(expression);
  if (!parsed || !isValidCronTimezone(timezone)) return undefined;
  const formatter = createCronDateFormatter(timezone);
  let candidate = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  if (isLeapDayOnlySchedule(parsed)) {
    return computeNextLeapDayRunAt(candidate, parsed, formatter);
  }
  for (let index = 0; index < MAX_SEARCH_MINUTES; index += 1) {
    if (matchesCron(candidate, parsed, formatter)) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + MINUTE_MS);
  }
  return undefined;
}

function isLeapDayOnlySchedule(cron: ParsedCron): boolean {
  return !cron.dayFieldsUseOr
    && cron.daysOfMonth.size === 1
    && cron.daysOfMonth.has(29)
    && cron.months.size === 1
    && cron.months.has(2)
    && cron.daysOfWeek.size === 7;
}

function computeNextLeapDayRunAt(
  after: Date,
  cron: ParsedCron,
  formatter: Intl.DateTimeFormat,
): Date | undefined {
  const startYear = after.getUTCFullYear();
  for (let year = startYear; year <= startYear + 8; year += 1) {
    if (!isLeapYear(year)) continue;
    let candidate = new Date(Date.UTC(year, 1, 28));
    const end = Date.UTC(year, 2, 2);
    while (candidate.getTime() < end) {
      if (candidate.getTime() >= after.getTime() && matchesCron(candidate, cron, formatter)) {
        return candidate;
      }
      candidate = new Date(candidate.getTime() + MINUTE_MS);
    }
  }
  return undefined;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayFieldsUseOr: boolean;
};

function parseCronExpression(expression: string): ParsedCron | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return undefined;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const parsed = {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dayOfMonth, 1, 31),
    months: parseField(month, 1, 12),
    daysOfWeek: parseField(dayOfWeek, 0, 7),
    // Unix cron keeps AND semantics when either day field starts with *, including */n.
    dayFieldsUseOr: !dayOfMonth.startsWith("*") && !dayOfWeek.startsWith("*"),
  };
  if (
    !parsed.minutes ||
    !parsed.hours ||
    !parsed.daysOfMonth ||
    !parsed.months ||
    !parsed.daysOfWeek
  ) {
    return undefined;
  }
  if (parsed.daysOfWeek.has(7)) {
    parsed.daysOfWeek.add(0);
    parsed.daysOfWeek.delete(7);
  }
  return parsed as ParsedCron;
}

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const output = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(trimmed)) return undefined;
    const stepParts = trimmed.split("/");
    if (stepParts.length > 2) return undefined;
    const base = stepParts[0];
    if (stepParts.length === 2 && base !== "*" && !base.includes("-")) return undefined;
    const step = stepParts[1] === undefined ? 1 : Number.parseInt(stepParts[1], 10);
    if (!Number.isInteger(step) || step <= 0) return undefined;

    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const [rawStart, rawEnd] = base.split("-");
      start = Number.parseInt(rawStart, 10);
      end = Number.parseInt(rawEnd, 10);
    } else {
      start = Number.parseInt(base, 10);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      return undefined;
    }
    for (let value = start; value <= end; value += step) {
      output.add(value);
    }
  }
  return output;
}

type CronDateParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function createCronDateFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
}

function readCronDateParts(date: Date, formatter: Intl.DateTimeFormat): CronDateParts | undefined {
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  const minute = Number.parseInt(values.minute, 10);
  const hour = Number.parseInt(values.hour, 10);
  const dayOfMonth = Number.parseInt(values.day, 10);
  const month = Number.parseInt(values.month, 10);
  const dayOfWeek = WEEKDAY_INDEX[values.weekday];
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(dayOfMonth) ||
    !Number.isInteger(month) ||
    dayOfWeek === undefined
  ) {
    return undefined;
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function matchesCron(date: Date, cron: ParsedCron, formatter: Intl.DateTimeFormat): boolean {
  const parts = readCronDateParts(date, formatter);
  if (!parts) return false;
  const dayOfMonthMatches = cron.daysOfMonth.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.daysOfWeek.has(parts.dayOfWeek);
  const dayMatches = cron.dayFieldsUseOr
    ? dayOfMonthMatches || dayOfWeekMatches
    : dayOfMonthMatches && dayOfWeekMatches;
  return (
    cron.minutes.has(parts.minute) &&
    cron.hours.has(parts.hour) &&
    cron.months.has(parts.month) &&
    dayMatches
  );
}
