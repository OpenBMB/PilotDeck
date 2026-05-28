import type { CronSchedule } from "../protocol/types.js";

const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 366 * 24 * 60;

export function computeNextRunAt(schedule: CronSchedule, after: Date): Date | undefined {
  if (schedule.type === "once") {
    const runAt = new Date(schedule.runAt);
    return Number.isNaN(runAt.getTime()) ? undefined : runAt;
  }
  return computeNextCronRunAt(schedule.expression, after);
}

export function computeNextCronRunAt(expression: string, after: Date): Date | undefined {
  const parsed = parseCronExpression(expression);
  if (!parsed) return undefined;
  let candidate = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let index = 0; index < MAX_SEARCH_MINUTES; index += 1) {
    if (matchesCron(candidate, parsed)) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + MINUTE_MS);
  }
  return undefined;
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

function matchesCron(date: Date, cron: ParsedCron): boolean {
  return (
    cron.minutes.has(date.getUTCMinutes()) &&
    cron.hours.has(date.getUTCHours()) &&
    cron.daysOfMonth.has(date.getUTCDate()) &&
    cron.months.has(date.getUTCMonth() + 1) &&
    cron.daysOfWeek.has(date.getUTCDay())
  );
}
