import type { PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import type { PilotDeckToolScheduler } from "./ToolScheduler.js";

export type ConcurrentToolSchedulerOptions = {
  /** Maximum active runtime calls per executeAll batch. Defaults to 4. */
  maxConcurrency?: number;
};

/**
 * Runs consecutive concurrency-safe calls in a bounded pool. Every other
 * call is a barrier: earlier calls finish before it starts, and later calls
 * wait for it to finish. Results always follow the submitted call order.
 */
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
    const pending = new Set<Promise<void>>();
    // Wrap the error so even a rejection with undefined stops dispatch.
    let failure: { error: unknown } | undefined;
    const throwIfFailed = (): void => {
      if (failure) throw failure.error;
    };

    const startConcurrent = (index: number): void => {
      const execution = (async () => {
        try {
          results[index] = await this.runtime.execute(calls[index], context);
        } catch (error) {
          failure ??= { error };
        }
      })();
      const settled = execution.finally(() => { pending.delete(settled); });
      pending.add(settled);
    };

    try {
      for (let index = 0; index < calls.length; index++) {
        if (pending.size >= this.maxConcurrency) {
          await Promise.race(pending);
        }
        throwIfFailed();

        const call = calls[index];
        // On cancellation, drain started calls and let ToolRuntime produce
        // the usual audited tool_aborted result for each remaining call.
        if (context.abortSignal?.aborted || !this.registry.get(call.name)?.isConcurrencySafe(call.input)) {
          await Promise.all(pending);
          throwIfFailed();
          results[index] = await this.runtime.execute(call, context);
        } else {
          startConcurrent(index);
        }
      }
      await Promise.all(pending);
      throwIfFailed();
      return results;
    } finally {
      // Unexpected runtime/classification failures must not leave tools
      // running after the caller has observed this batch's rejection.
      await Promise.all(pending);
    }
  }
}
