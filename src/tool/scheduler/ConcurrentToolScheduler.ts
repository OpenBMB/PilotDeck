import type { PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import type { PilotDeckToolScheduler } from "./ToolScheduler.js";

/**
 * Executes concurrency-safe tool calls in parallel and serializes the rest.
 *
 * Ordering: all concurrency-safe calls run first (via Promise.all), then
 * non-safe calls run sequentially.  Results are returned in the original
 * call order regardless of execution order.
 */
export class ConcurrentToolScheduler implements PilotDeckToolScheduler {
  constructor(
    private readonly runtime: ToolRuntime,
    private readonly registry: ToolRegistry,
  ) {}

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
  ): Promise<PilotDeckToolResult[]> {
    if (calls.length <= 1) {
      const results: PilotDeckToolResult[] = [];
      for (const call of calls) {
        results.push(await this.runtime.execute(call, context));
      }
      return results;
    }

    const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);

    const concurrentIndices: number[] = [];
    const sequentialIndices: number[] = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = this.registry.get(call.name);
      if (tool && tool.isConcurrencySafe(call.input)) {
        concurrentIndices.push(i);
      } else {
        sequentialIndices.push(i);
      }
    }

    // Phase 1: run concurrency-safe calls in parallel
    if (concurrentIndices.length > 0) {
      const promises = concurrentIndices.map(async (idx) => {
        const result = await this.runtime.execute(calls[idx], context);
        resultSlots[idx] = result;
      });
      await Promise.all(promises);
    }

    // Phase 2: run the rest sequentially
    for (const idx of sequentialIndices) {
      resultSlots[idx] = await this.runtime.execute(calls[idx], context);
    }

    return resultSlots as PilotDeckToolResult[];
  }
}
