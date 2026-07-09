export const CRON_SCHEDULE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      required: ["type", "runAt"],
      additionalProperties: false,
      properties: {
        // Moonshot/Kimi requires an explicit type alongside const/enum.
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
        expression: { type: "string" },
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
