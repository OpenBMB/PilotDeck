import type { AgentEvent } from "../protocol/events.js";
import type { PilotFailureGuardConfig } from "../../pilot/config/types.js";
import { COUNTED_TOOL_ERROR_CODES, resolveToolUnit, toolLabel } from "./classify.js";

export const TOOL_FAILURE_LIMIT_REACHED = "tool_failure_limit_reached";
export const MODEL_FAILURE_LIMIT_REACHED = "model_failure_limit_reached";

export type ToolTrip = { kind: "tool"; unit: string; label: string; failures: number; limit: number };
export type ModelTrip = { kind: "model"; failures: number; limit: number };
export type GuardTrip = ToolTrip | ModelTrip;
export type LastModelInfo = { provider?: string; model?: string };

export class FailureGuard {
  private readonly toolFailures = new Map<string, number>();
  private modelFailures = 0;
  private tripped = false;

  constructor(private readonly config: PilotFailureGuardConfig) {}

  get isTripped(): boolean {
    return this.tripped;
  }

  onToolFinished(toolName: string, ok: boolean, errorCode: string | undefined): ToolTrip | undefined {
    if (this.tripped || ok || !errorCode || !COUNTED_TOOL_ERROR_CODES.has(errorCode)) return undefined;
    const resolved = resolveToolUnit(toolName, this.config.toolFailureLimits);
    if (!resolved) return undefined;

    const failures = (this.toolFailures.get(resolved.unit) ?? 0) + 1;
    this.toolFailures.set(resolved.unit, failures);
    if (resolved.limit <= 0 || failures < resolved.limit) return undefined;

    this.tripped = true;
    return {
      kind: "tool",
      unit: resolved.unit,
      label: toolLabel(resolved.unit, this.config.toolLabels),
      failures,
      limit: resolved.limit,
    };
  }

  onModelFailure(): ModelTrip | undefined {
    if (this.tripped) return undefined;
    this.modelFailures += 1;
    const limit = this.config.modelFailureLimit;
    if (limit <= 0 || this.modelFailures < limit) return undefined;
    this.tripped = true;
    return { kind: "model", failures: this.modelFailures, limit };
  }

  observe(event: AgentEvent): GuardTrip | undefined {
    if (event.type === "tool_result" || event.type === "subagent_tool_result") {
      const result = event.result;
      if (result.type !== "error") return undefined;
      return this.onToolFinished(result.toolName, false, result.error.code);
    }
    if (event.type === "turn_continued" && event.reason === "model_error") {
      return this.onModelFailure();
    }
    return undefined;
  }
}

export function buildGuardTripMessage(
  trip: GuardTrip,
  model?: LastModelInfo,
): { code: string; message: string; detail: Record<string, unknown> } {
  if (trip.kind === "tool") {
    return {
      code: TOOL_FAILURE_LIMIT_REACHED,
      message: `${trip.label} 服务本次任务已失败 ${trip.failures} 次，已自动停止，请稍后重试`,
      detail: {
        unit: trip.unit,
        toolLabel: trip.label,
        failures: trip.failures,
        limit: trip.limit,
      },
    };
  }
  return {
    code: MODEL_FAILURE_LIMIT_REACHED,
    message: `模型调用本次任务已失败 ${trip.failures} 次，已自动停止，请稍后重试`,
    detail: {
      failures: trip.failures,
      limit: trip.limit,
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.model ? { model: model.model } : {}),
    },
  };
}
