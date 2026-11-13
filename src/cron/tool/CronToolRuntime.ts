import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
  CronRunNowInput,
  CronRunNowResult,
} from "../protocol/types.js";

export type CronToolRuntime = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  listTasks(input: CronListInput): Promise<CronListResult>;
  deleteTask(input: CronDeleteInput): Promise<CronDeleteResult>;
  stopTask(input: CronStopInput): Promise<CronStopResult>;
  updateTask(input: CronUpdateInput): Promise<CronUpdateResult>;
  runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult>;
};
