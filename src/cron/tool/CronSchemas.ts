export const CRON_SCHEDULE_SCHEMA = {
  anyOf: [
    {
      type: "object", required: ["type", "everySeconds"], additionalProperties: false,
      properties: { type: { const: "interval" }, everySeconds: { type: "integer", minimum: 60 }, anchorAt: { type: "string" } },
    },
    {
      type: "object", required: ["type", "ordinal", "weekday", "hour", "minute", "timezone"], additionalProperties: false,
      properties: {
        type: { const: "monthly" }, ordinal: { type: "integer", enum: [1, 2, 3, 4, -1] },
        weekday: { type: "integer", minimum: 0, maximum: 6, description: "0=Sunday, 1=Monday." },
        hour: { type: "integer", minimum: 0, maximum: 23 }, minute: { type: "integer", minimum: 0, maximum: 59 }, timezone: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "runAt"],
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "once" },
        runAt: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "expression"],
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "cron" },
        expression: {
          type: "string",
          description: "Five numeric fields: minute hour day-of-month month day-of-week (0 or 7 = Sunday). Restricted day fields match with OR; wildcard day fields match with AND. Use type=monthly for the first or last weekday of a month, and type=interval for elapsed-time intervals.",
        },
        timezone: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "amount", "unit"],
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "delay" },
        amount: { type: "number", exclusiveMinimum: 0 },
        unit: { type: "string", enum: ["second", "minute", "hour", "day"] },
      },
    },
  ],
} as const;
