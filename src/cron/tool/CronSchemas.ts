const COMMON_SCHEDULES = [
  {
    type: "object", required: ["type", "times", "timezone"], additionalProperties: false,
    properties: {
      type: { type: "string", const: "calendar" },
      times: { type: "array", minItems: 1, maxItems: 1440, uniqueItems: true,
        items: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" },
        description: "Daily or weekly local 24-hour times. Each HH:mm is an exact hour and minute pair." },
      weekdays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true,
        items: { type: "integer", minimum: 0, maximum: 6 },
        description: "0=Sunday, 1=Monday. Each time applies to every selected day. Omit for every day." },
      timezone: { type: "string", description: "IANA timezone such as Asia/Shanghai." },
    },
  },
  {
    type: "object", required: ["type", "runAt"], additionalProperties: false,
    properties: {
      type: { type: "string", const: "once" },
      runAt: { type: "string", description: "An absolute date and time with Z or an explicit UTC offset." },
    },
  },
  {
    type: "object", required: ["type", "expression"], additionalProperties: false,
    properties: {
      type: { type: "string", const: "cron" },
      expression: {
        type: "string",
        description: "Five numeric fields in order: minute, hour, day-of-month, month, day-of-week (0 or 7 = Sunday). Use for a fixed date each month or year. When both day fields are restricted they match with OR; a wildcard day field uses AND.",
      },
      timezone: { type: "string", description: "IANA timezone for the expression." },
    },
  },
  {
    type: "object", required: ["type", "amount", "unit"], additionalProperties: false,
    properties: {
      type: { type: "string", const: "delay" },
      amount: { type: "number", exclusiveMinimum: 0, description: "Positive one-time delay from creation." },
      unit: { type: "string", enum: ["second", "minute", "hour", "day"] },
    },
  },
] as const;

const INTERVAL_SCHEDULE = {
  type: "object", required: ["type", "everySeconds"], additionalProperties: false,
  properties: {
    type: { type: "string", const: "interval" },
    everySeconds: { type: "integer", minimum: 60 },
    anchorAt: { type: "string", description: "Optional reference time for the interval. Defaults to creation time." },
  },
} as const;

const LEGACY_MONTHLY_WEEKDAY_SCHEDULE = {
  type: "object", required: ["type", "ordinal", "weekday", "hour", "minute", "timezone"], additionalProperties: false,
  description: "An existing monthly weekday rule.",
  properties: {
    type: { type: "string", const: "monthly" }, ordinal: { type: "integer", enum: [1, 2, 3, 4, -1] },
    weekday: { type: "integer", minimum: 0, maximum: 6, description: "0=Sunday, 1=Monday." },
    hour: { type: "integer", minimum: 0, maximum: 23 }, minute: { type: "integer", minimum: 0, maximum: 59 }, timezone: { type: "string" },
  },
} as const;

export const CRON_CREATE_SCHEDULE_SCHEMA = {
  anyOf: [...COMMON_SCHEDULES, {
    ...INTERVAL_SCHEDULE,
    properties: {
      ...INTERVAL_SCHEDULE.properties,
      everySeconds: { ...INTERVAL_SCHEDULE.properties.everySeconds, multipleOf: 60,
        description: "Elapsed interval in seconds, as a positive multiple of 60. A day is 86400 seconds." },
    },
  }],
} as const;

export const CRON_UPDATE_SCHEDULE_SCHEMA = {
  anyOf: [...COMMON_SCHEDULES, INTERVAL_SCHEDULE, LEGACY_MONTHLY_WEEKDAY_SCHEDULE],
} as const;
