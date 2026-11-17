export type CronTaskSchedule =
  | { type: "interval"; everySeconds: number; anchorAt: string }
  | { type: "monthly"; ordinal: 1 | 2 | 3 | 4 | -1; weekday: number; hour: number; minute: number; timezone: string }
  | {
      type: "once";
      runAt: string;
    }
  | {
      type: "cron";
      expression: string;
      timezone?: string;
    };

export type CronCreateSchedule =
  | CronTaskSchedule
  | { type: "interval"; everySeconds: number; anchorAt?: string }
  | {
      type: "delay";
      amount: number;
      unit: "second" | "minute" | "hour" | "day";
    };

export type CronSchedule = CronCreateSchedule;
