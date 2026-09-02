export type IntervalUnit = "minutes" | "hours" | "days" | "weeks";

export const DEFAULT_INDEX_MINUTES = 30;
export const DEFAULT_DREAM_MINUTES = 60;

export const INDEX_INTERVAL_UNITS: IntervalUnit[] = ["minutes", "hours", "days"];
export const DREAM_INTERVAL_UNITS: IntervalUnit[] = ["hours", "days", "weeks"];

const MINUTES_PER_UNIT: Record<IntervalUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10_080,
};

type MemoryIntervals = {
  autoIndexIntervalMinutes?: number;
  autoDreamIntervalMinutes?: number;
};

export function isIntervalUnit(
  value: string,
  allowed: readonly IntervalUnit[] = [
    "minutes",
    "hours",
    "days",
    "weeks",
  ],
): value is IntervalUnit {
  return (allowed as readonly string[]).includes(value);
}

export function parseIntervalUnit(
  value: string,
  allowed: readonly IntervalUnit[],
): IntervalUnit {
  return isIntervalUnit(value, allowed) ? value : allowed[0];
}

export function toDisplayUnit(
  minutesValue: number | undefined,
  fallbackMinutes: number,
  allowedUnits: readonly IntervalUnit[] = INDEX_INTERVAL_UNITS,
): { value: number; unit: IntervalUnit } {
  const resolved = minutesValue ?? fallbackMinutes;
  const smallest = allowedUnits[0];
  if (resolved <= 0) {
    return { value: 0, unit: smallest };
  }
  for (let index = allowedUnits.length - 1; index >= 0; index -= 1) {
    const unit = allowedUnits[index];
    const perUnit = MINUTES_PER_UNIT[unit];
    if (resolved % perUnit === 0) {
      return { value: resolved / perUnit, unit };
    }
  }
  return {
    value: Math.max(0, Math.floor(resolved / MINUTES_PER_UNIT[smallest])),
    unit: smallest,
  };
}

export function toDisplayValue(
  minutesValue: number | undefined,
  unit: IntervalUnit,
  fallbackMinutes: number,
): number {
  const resolved = minutesValue ?? fallbackMinutes;
  return Math.max(0, Math.floor(resolved / MINUTES_PER_UNIT[unit]));
}

export function toMinutes(
  value: number | undefined,
  unit: IntervalUnit,
): number {
  const safe =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  return safe * MINUTES_PER_UNIT[unit];
}

export function resolveEnabledMemoryIntervals(
  memory: MemoryIntervals | undefined,
): Required<MemoryIntervals> {
  return {
    autoIndexIntervalMinutes:
      memory?.autoIndexIntervalMinutes ?? DEFAULT_INDEX_MINUTES,
    autoDreamIntervalMinutes:
      memory?.autoDreamIntervalMinutes ?? DEFAULT_DREAM_MINUTES,
  };
}
