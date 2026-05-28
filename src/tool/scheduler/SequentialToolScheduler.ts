import type { PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { PilotDeckToolScheduler } from "./ToolScheduler.js";

export class SequentialToolScheduler implements PilotDeckToolScheduler {
  constructor(private readonly runtime: ToolRuntime) {}

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
  ): Promise<PilotDeckToolResult[]> {
    const results: PilotDeckToolResult[] = [];
    for (const call of calls) {
      results.push(await this.runtime.execute(call, context));
    }
    return results;
  }
}
