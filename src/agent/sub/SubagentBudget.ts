export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
export const SUBAGENT_PARENT_HANDOFF_RESERVE_MS = 30_000;

export type SubagentExecutionBudget = {
  timeoutMs: number;
  configuredTimeoutMs: number;
  parentBounded: boolean;
};

export class SubagentTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Subagent timed out after ${timeoutMs}ms.`);
    this.name = "SubagentTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function resolveSubagentExecutionBudget(input: {
  configuredTimeoutMs?: number;
  parentDeadlineAtMs?: number;
  nowMs?: number;
  parentHandoffReserveMs?: number;
}): SubagentExecutionBudget | undefined {
  const configuredTimeoutMs = positiveInteger(input.configuredTimeoutMs)
    ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const parentDeadlineAtMs = finiteInteger(input.parentDeadlineAtMs);
  if (parentDeadlineAtMs === undefined) {
    return {
      timeoutMs: configuredTimeoutMs,
      configuredTimeoutMs,
      parentBounded: false,
    };
  }

  const nowMs = finiteInteger(input.nowMs) ?? Date.now();
  const reserveMs = nonNegativeInteger(input.parentHandoffReserveMs)
    ?? SUBAGENT_PARENT_HANDOFF_RESERVE_MS;
  const availableMs = parentDeadlineAtMs - nowMs - reserveMs;
  if (availableMs <= 0) return undefined;

  return {
    timeoutMs: Math.min(configuredTimeoutMs, availableMs),
    configuredTimeoutMs,
    parentBounded: availableMs < configuredTimeoutMs,
  };
}

export function appendSubagentBudgetDirective(
  directive: string,
  budget: SubagentExecutionBudget,
): string {
  const seconds = Math.max(1, Math.ceil(budget.timeoutMs / 1_000));
  return [
    directive,
    "",
    "<subagent-execution-budget>",
    `Hard wall-clock budget: ${seconds} seconds.`,
    "Prioritize the requested outcome and the strongest available evidence.",
    "If repeated retrieval or tool attempts stop producing materially better evidence, return the best current result with explicit gaps instead of cycling through equivalent alternatives.",
    "Leave enough time to produce the requested final report before this budget expires.",
    "</subagent-execution-budget>",
  ].join("\n");
}

export function composeSubagentAbortSignal(input: {
  parent?: AbortSignal;
  timeoutMs: number;
}): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  let timedOut = false;

  if (input.parent) {
    if (input.parent.aborted) {
      controller.abort(input.parent.reason);
    } else {
      const onAbort = () => controller.abort(input.parent?.reason);
      input.parent.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => input.parent?.removeEventListener("abort", onAbort));
    }
  }

  if (!controller.signal.aborted) {
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new SubagentTimeoutError(input.timeoutMs));
    }, input.timeoutMs);
    cleanupFns.push(() => clearTimeout(timeout));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanupFns) cleanup();
    },
    timedOut: () => timedOut,
  };
}

export function isSubagentTimeoutError(error: unknown): error is SubagentTimeoutError {
  return error instanceof SubagentTimeoutError
    || (error instanceof Error && error.name === "SubagentTimeoutError");
}

export async function awaitSubagentOperation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function finiteInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(typeof signal.reason === "string" ? signal.reason : "Subagent operation aborted.");
}
