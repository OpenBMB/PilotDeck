export class PilotDeckLifecycleRuntimeError extends Error {
  readonly name = "PilotDeckLifecycleRuntimeError";

  constructor(
    readonly code: "hook_blocked" | "hook_failed",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
