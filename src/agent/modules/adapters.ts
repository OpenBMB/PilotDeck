import type { RouterDecision } from "../../router/index.js";
import type { AgentRouterRuntime } from "../runtime/AgentRuntimeDependencies.js";
import type { PilotDeckToolDefinition, PilotDeckToolResult, PilotDeckToolRuntimeContext, PilotDeckToolScheduler, PilotDeckToolCall } from "../../tool/index.js";
import type { AgentExecutionContext, ModelInvokerPort, PreparedModelInvocation, ToolPort } from "./protocol.js";

export type LegacyModelAdapterOptions = {
  isMainAgent?: boolean;
  projectPath?: string;
  fallbackModels?: ReadonlyArray<{ provider: string; model: string }>;
  managedModelPolicy?: { allow: string[]; deny: string[] };
  materialize?: (decision: RouterDecision, request: import("../../model/index.js").CanonicalModelRequest) => import("../../model/index.js").CanonicalModelRequest;
};

export function createRouterModelInvokerPort(
  router: AgentRouterRuntime,
  options: LegacyModelAdapterOptions = {},
): ModelInvokerPort {
  return {
    async prepare({ request, context }): Promise<PreparedModelInvocation> {
      const decision = context.modelOverride
        ? {
            provider: context.modelOverride.provider,
            model: context.modelOverride.model,
            scenarioType: "explicit" as const,
            isSubagent: !(options.isMainAgent ?? true),
            orchestrating: false,
            resolvedFrom: "explicit" as const,
            mutations: {},
          }
        : await router.decide({
            request,
            sessionId: context.sessionId,
            isMainAgent: options.isMainAgent ?? true,
            metadata: context.metadata,
          });
      const materialized = options.materialize
        ? options.materialize(decision, request)
        : router.materializeRequest
          ? router.materializeRequest(decision, request)
          : { ...request, provider: decision.provider, model: decision.model };
      return {
        request: materialized,
        provider: decision.provider,
        model: decision.model,
        opaque: decision,
      };
    },
    stream: ({ prepared, context }) => {
      const decision = prepared.opaque as RouterDecision | undefined;
      if (!decision) throw new Error("Router model adapter received an unprepared invocation.");
      return router.execute(decision, prepared.request, {
        sessionId: context.sessionId,
        turnId: context.turnId,
        projectPath: options.projectPath,
        abortSignal: context.abortSignal,
        fallbackModels: options.fallbackModels,
        managedModelPolicy: context.managedModelPolicy ?? options.managedModelPolicy,
      });
    },
  };
}

export function createToolSchedulerPort(
  registry: { list(): PilotDeckToolDefinition[] },
  scheduler: PilotDeckToolScheduler,
): ToolPort {
  return {
    list: () => registry.list(),
    executeAll: (calls: PilotDeckToolCall[], context: PilotDeckToolRuntimeContext, _execution: AgentExecutionContext) =>
      scheduler.executeAll(calls, context),
  };
}
