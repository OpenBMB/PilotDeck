export type AlwaysOnErrorCode =
  | "config_invalid"
  | "plan_quota_exhausted"
  | "plan_invalid"
  | "report_invalid"
  | "workspace_unavailable"
  | "workspace_prepare_failed"
  | "workspace_dispose_failed"
  | "lock_busy"
  | "watcher_failed"
  | "internal";

export class AlwaysOnError extends Error {
  readonly code: AlwaysOnErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AlwaysOnErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AlwaysOnError";
    this.code = code;
    this.details = details;
  }
}
