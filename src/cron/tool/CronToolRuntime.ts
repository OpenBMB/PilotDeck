import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronStopInput,
  CronStopResult,
} from "../protocol/types.js";

export type CronToolRuntime = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  listTasks(input: CronListInput): Promise<CronListResult>;
  deleteTask(input: CronDeleteInput): Promise<CronDeleteResult>;
  stopTask(input: CronStopInput): Promise<CronStopResult>;
};
