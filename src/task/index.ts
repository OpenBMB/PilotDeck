export {
  BackgroundTaskRuntime,
  type BackgroundTaskRuntimeOptions,
  type StartTaskSpec,
  type StartManagedTaskSpec,
  type StopTaskOptions,
} from "./runtime/BackgroundTaskRuntime.js";
export { TaskOutputStore, type TaskOutputStoreOptions } from "./storage/TaskOutputStore.js";
export type {
  PilotDeckBackgroundAgentTask,
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTask,
  PilotDeckBackgroundTaskKind,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckBackgroundTaskStatus,
  PilotDeckTaskOutputSlice,
} from "./protocol/types.js";
