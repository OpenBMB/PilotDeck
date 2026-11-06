export type SimpleCronSchedule =
  | { mode: 'daily'; time: string }
  | { mode: 'weekly'; time: string; weekday: number }
  | { mode: 'monthly'; time: string; dayOfMonth: number }
  | { mode: 'yearly'; time: string; dayOfMonth: number; monthOfYear: number };

export type SimpleRecurrenceMode = SimpleCronSchedule['mode'];

export function buildSimpleCronExpression(schedule: SimpleCronSchedule): string {
  const { hour, minute } = parseTime(schedule.time);

  switch (schedule.mode) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      assertIntegerInRange(schedule.weekday, 0, 6, 'weekday');
      return `${minute} ${hour} * * ${schedule.weekday}`;
    case 'monthly':
      assertIntegerInRange(schedule.dayOfMonth, 1, 31, 'dayOfMonth');
      return `${minute} ${hour} ${schedule.dayOfMonth} * *`;
    case 'yearly':
      assertIntegerInRange(schedule.monthOfYear, 1, 12, 'monthOfYear');
      assertIntegerInRange(schedule.dayOfMonth, 1, 31, 'dayOfMonth');
      if (!isValidYearlyDate(schedule.monthOfYear, schedule.dayOfMonth)) {
        throw new RangeError('Invalid yearly date');
      }
      return `${minute} ${hour} ${schedule.dayOfMonth} ${schedule.monthOfYear} *`;
  }
}

export function parseSimpleCronExpression(expression: string): SimpleCronSchedule | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;

  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = parseIntegerInRange(minuteField, 0, 59);
  const hour = parseIntegerInRange(hourField, 0, 23);
  if (minute === undefined || hour === undefined) return undefined;

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (dayField === '*' && monthField === '*' && weekdayField === '*') {
    return { mode: 'daily', time };
  }

  if (dayField === '*' && monthField === '*') {
    const parsedWeekday = parseIntegerInRange(weekdayField, 0, 7);
    if (parsedWeekday !== undefined) {
      return { mode: 'weekly', time, weekday: parsedWeekday === 7 ? 0 : parsedWeekday };
    }
    return undefined;
  }

  if (monthField === '*' && weekdayField === '*') {
    const dayOfMonth = parseIntegerInRange(dayField, 1, 31);
    return dayOfMonth === undefined ? undefined : { mode: 'monthly', time, dayOfMonth };
  }

  if (weekdayField === '*') {
    const dayOfMonth = parseIntegerInRange(dayField, 1, 31);
    const monthOfYear = parseIntegerInRange(monthField, 1, 12);
    if (dayOfMonth !== undefined && monthOfYear !== undefined && isValidYearlyDate(monthOfYear, dayOfMonth)) {
      return { mode: 'yearly', time, dayOfMonth, monthOfYear };
    }
  }

  return undefined;
}

export function getYearlyMonthDayCount(month: number): number {
  assertIntegerInRange(month, 1, 12, 'month');
  // February 29 is a valid yearly schedule. It simply only runs in leap years.
  return new Date(2024, month, 0).getDate();
}

function isValidYearlyDate(month: number, day: number): boolean {
  return day <= getYearlyMonthDayCount(month);
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new RangeError('Invalid time');

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  assertIntegerInRange(hour, 0, 23, 'hour');
  assertIntegerInRange(minute, 0, 59, 'minute');
  return { hour, minute };
}

function parseIntegerInRange(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function assertIntegerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
}
