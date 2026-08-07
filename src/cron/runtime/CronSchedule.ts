import type { CronCreateSchedule } from "../protocol/types.js";
import { isValidCronTimezone } from "../CronTimezone.js";

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
  return computeNextCronRunAt(schedule.expression, after, schedule.timezone ?? fallbackTimezone);
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
  return cron.daysOfMonth.size === 1
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
    if (!trimmed) return undefined;
    const stepParts = trimmed.split("/");
    if (stepParts.length > 2) return undefined;
    const base = stepParts[0];
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
  return (
    cron.minutes.has(parts.minute) &&
    cron.hours.has(parts.hour) &&
    cron.daysOfMonth.has(parts.dayOfMonth) &&
    cron.months.has(parts.month) &&
    cron.daysOfWeek.has(parts.dayOfWeek)
  );
}
