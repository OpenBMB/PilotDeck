import type { PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import type { PilotDeckToolScheduler } from "./ToolScheduler.js";

export type ConcurrentToolSchedulerOptions = {
  /** Maximum active runtime calls in one batch. Defaults to four. */
  maxConcurrency?: number;
};

/** Executes consecutive safe calls in a bounded pool; exclusive calls are barriers. */
export class ConcurrentToolScheduler implements PilotDeckToolScheduler {
  private readonly maxConcurrency: number;

  constructor(
    private readonly runtime: ToolRuntime,
    private readonly registry: ToolRegistry,
    options: ConcurrentToolSchedulerOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive safe integer.");
    }
  }

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
  ): Promise<PilotDeckToolResult[]> {
    if (calls.length === 0) return [];
    if (calls.length === 1) return [await this.runtime.execute(calls[0], context)];

    const results = new Array<PilotDeckToolResult>(calls.length);
    const active = new Set<Promise<void>>();
    // Presence is separate from the rejected value (which may be undefined).
    let failure: { reason: unknown } | undefined;
    const checkFailure = (): void => { if (failure) throw failure.reason; };
    const start = (index: number): void => {
      const execution = (async () => {
        try {
          results[index] = await this.runtime.execute(calls[index], context, {
            requireConcurrencySafe: this.maxConcurrency > 1,
          });
        } catch (reason) {
          failure ??= { reason };
        }
      })();
      const tracked = execution.finally(() => { active.delete(tracked); });
      active.add(tracked);
    };

    try {
      for (let index = 0; index < calls.length; index++) {
        if (active.size >= this.maxConcurrency) await Promise.race(active);
        checkFailure();
        const call = calls[index];
        if (context.abortSignal?.aborted || !this.registry.get(call.name)?.isConcurrencySafe(call.input)) {
          await Promise.all(active);
          checkFailure();
          results[index] = await this.runtime.execute(call, context);
        } else {
          start(index);
        }
      }
      await Promise.all(active);
      checkFailure();
      return results;
    } finally {
      // Neither cancellation nor an unexpected failure may orphan started calls.
      await Promise.all(active);
    }
  }
}
