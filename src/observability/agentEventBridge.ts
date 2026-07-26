import type { AgentEvent } from "../agent/protocol/events.js";
import { fingerprintMessages, fingerprintToolResult, observationHash } from "./fingerprint.js";
import type { ObservationRecorder } from "./protocol.js";

export function observeAgentEvent(recorder: ObservationRecorder | undefined, event: AgentEvent): void {
  if (!recorder) return;
  const base = "turnId" in event
    ? { sessionId: event.sessionId, turnId: event.turnId }
    : { sessionId: event.sessionId };
  switch (event.type) {
    case "session_started":
      recorder.emit({ ...base, type: "session.started", priority: "critical" });
      return;
    case "session_ended":
      recorder.emit({ ...base, type: "session.completed", payload: { reason: event.reason }, priority: "critical" });
      return;
    case "turn_started":
      recorder.emit({ ...base, type: "turn.started", spanId: `turn:${event.turnId}`, priority: "critical" });
      return;
    case "input_accepted":
      recorder.emit({
        ...base,
        type: "turn.input.accepted",
        payload: fingerprintMessages(event.messages),
        priority: "critical",
      });
      return;
    case "tool_calls_detected":
      for (const call of event.calls) {
        recorder.emit({
          ...base,
          type: "tool.call.started",
          spanId: `tool:${call.id}`,
          parentSpanId: `turn:${event.turnId}`,
          payload: { toolCallId: call.id, toolName: call.name },
          priority: "critical",
        });
      }
      return;
    case "subagent_tool_calls_detected":
      for (const call of event.calls) {
        recorder.emit({
          ...base,
          type: "tool.call.started",
          spanId: `tool:${call.id}`,
          parentSpanId: `turn:${event.turnId}`,
          payload: {
            toolCallId: call.id,
            toolName: call.name,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
          priority: "critical",
        });
      }
      return;
    case "tool_result":
    case "subagent_tool_result":
      recorder.emit({
        ...base,
        type: "tool.call.completed",
        spanId: `tool:${event.result.toolCallId}`,
        parentSpanId: `turn:${event.turnId}`,
        payload: {
          toolCallId: event.result.toolCallId,
          toolName: event.result.toolName,
          ...(event.type === "subagent_tool_result"
            ? { subagentId: event.subagentId, subagentType: event.subagentType }
            : {}),
          ...fingerprintToolResult(event.result),
        },
        priority: "critical",
      });
      return;
    case "permission_requested":
      recorder.emit({
        ...base,
        type: "permission.requested",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName },
      });
      return;
    case "permission_denied":
      recorder.emit({
        ...base,
        type: "permission.resolved",
        payload: { toolName: event.toolName, decision: "deny", reasonHash: observationHash(event.reason) },
      });
      return;
    case "context_budget":
      recorder.emit({ ...base, type: "context.budget.measured", payload: { ...event.snapshot }, priority: "important" });
      return;
    case "context_compaction_evaluated":
      recorder.emit({
        ...base,
        type: "context.compaction.evaluated",
        payload: {
          triggered: event.triggered,
          attemptedTiers: event.attemptedTiers,
          applied: event.applied,
          appliedTier: event.appliedTier,
          rejectionReason: event.rejectionReason,
          summaryAttempted: event.summaryAttempted,
          summarySucceeded: event.summarySucceeded,
          preState: event.preState,
          postState: event.postState,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          preRatio: event.preRatio,
          postRatio: event.postRatio,
        },
      });
      return;
    case "progress_lease_evaluated":
      recorder.emit({
        ...base,
        type: "harness.decision",
        payload: {
          component: "progress-lease",
          policyVersion: "progress-lease/v4",
          decision: event.decision,
          reasonCode: event.reason,
          observed: {
            scope: event.scope,
            phase: event.phase,
            blockingCode: event.blockingCode,
            remainingCount: event.remainingCount,
            progressOrdinal: event.progressOrdinal,
            repairOrdinal: event.repairOrdinal,
            repairPreparationOrdinal: event.repairPreparationOrdinal,
            stagnantObservations: event.stagnantObservations,
          },
          forceBoundaryNext: event.forceBoundaryNext,
        },
        priority: "important",
      });
      return;
    case "subagent_started":
      recorder.emit({
        ...base,
        type: "subagent.started",
        spanId: `subagent:${event.subagentId}`,
        parentSpanId: `turn:${event.turnId}`,
        payload: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCallId: event.toolCallId,
        },
      });
      return;
    case "subagent_completed":
      recorder.emit({
        ...base,
        type: event.success ? "subagent.completed" : "subagent.failed",
        spanId: `subagent:${event.subagentId}`,
        parentSpanId: `turn:${event.turnId}`,
        payload: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          success: event.success,
          durationMs: event.durationMs,
        },
      });
      return;
    case "turn_failed":
      recorder.emit({
        ...base,
        type: "turn.failed",
        spanId: `turn:${event.turnId}`,
        payload: { errorCode: event.error.code },
        priority: "critical",
      });
      return;
    case "turn_completed":
      recorder.emit({
        ...base,
        type: "turn.completed",
        spanId: `turn:${event.turnId}`,
        payload: {
          resultType: event.result.type,
          stopReason: event.result.stopReason,
          usage: event.result.usage,
          turns: event.result.turns,
          startedAt: event.result.startedAt,
          completedAt: event.result.completedAt,
        },
        priority: "critical",
      });
      return;
    default:
      return;
  }
}
