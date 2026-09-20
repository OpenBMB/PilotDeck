import type { AgentSessionEventRecorder } from "../../session/AgentSessionEventRecorder.js";
import type { ToolPort } from "../protocol.js";

export function createDurableToolPort(
  delegate: ToolPort,
  recorder: AgentSessionEventRecorder,
): ToolPort {
  return {
    list: () => delegate.list(),
    async executeAll(calls, context, execution) {
      await recorder.recordToolCalls(execution.sessionId, execution.turnId, calls);
      const results = await delegate.executeAll(calls, context, execution);
      // AgentLoop terminates an aborted turn before model-visible Tool results
      // are projected. Keep the internal durable stream aligned with that
      // boundary: a late scheduler result is not a settled tool outcome.
      if (execution.abortSignal?.aborted) return results;
      await recorder.recordToolResults(execution.sessionId, execution.turnId, results);
      return results;
    },
  };
}
