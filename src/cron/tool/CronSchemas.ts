export const CRON_SCHEDULE_SCHEMA = {
  anyOf: [
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
          description: "Five numeric fields: minute hour day-of-month month day-of-week (0 or 7 = Sunday). If neither day field starts with '*', they match with OR; if either starts with '*' (including */n), they match with AND. Explicit full ranges are not wildcards. '0 9 1 * 1' means the 1st of each month OR every Monday, not their intersection. Do not use '0 9 1-7 * 1' for the first Monday; schedule explicit one-time dates instead.",
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
