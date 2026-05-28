import type { PilotDeckHookEvent } from "../protocol/events.js";

export type PilotDeckHookExecutionEvent =
  | {
      type: "started";
      hookName: string;
      hookEvent: PilotDeckHookEvent;
    }
  | {
      type: "response";
      hookName: string;
      hookEvent: PilotDeckHookEvent;
      stdout: string;
      stderr: string;
      exitCode?: number;
      outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
    };

export type PilotDeckHookExecutionEventHandler = (event: PilotDeckHookExecutionEvent) => void;

export class HookExecutionEventBus {
  private handlers = new Set<PilotDeckHookExecutionEventHandler>();

  subscribe(handler: PilotDeckHookExecutionEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: PilotDeckHookExecutionEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
