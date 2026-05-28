export const CRON_SCHEDULE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      required: ["type", "runAt"],
      additionalProperties: false,
      properties: {
        type: { const: "once" },
        runAt: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "expression"],
      additionalProperties: false,
      properties: {
        type: { const: "cron" },
        expression: { type: "string" },
        timezone: { type: "string" },
      },
    },
  ],
} as const;
