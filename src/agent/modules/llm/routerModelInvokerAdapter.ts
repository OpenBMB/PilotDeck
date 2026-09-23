import { snapshotCanonicalModelRequest, type CanonicalModelRequest } from "../../../model/index.js";
import type { RouterDecision } from "../../../router/index.js";
import type { AgentRouterRuntime } from "../../runtime/AgentRuntimeDependencies.js";
import type { ModelInvokerPort, PreparedModelInvocation } from "../protocol.js";

export type RouterModelInvokerAdapterOptions = {
  isMainAgent?: boolean;
  projectPath?: string;
  fallbackModels?: ReadonlyArray<{ provider: string; model: string }>;
  managedModelPolicy?: {
    allow: readonly string[];
    deny: readonly string[];
  };
  invocationLogSink?: import("../../../storage/legalDataStorage.js").ModelInvocationLogSink;
  workspaceId?: string;
  storageConfigVersion?: string;
  materialize?: (decision: RouterDecision, request: CanonicalModelRequest) => CanonicalModelRequest;
};

/** Native provider adapter from PilotDeck's Router runtime to ModelInvokerPort. */
export function createRouterModelInvokerPort(
  router: AgentRouterRuntime,
  options: RouterModelInvokerAdapterOptions = {},
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
        request: snapshotCanonicalModelRequest(materialized),
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
        runId: context.runId,
        caller: options.isMainAgent === false ? "subagent" : "agent",
        workspaceId: context.workspaceId ?? options.workspaceId,
        storageConfigVersion: context.storageConfigVersion ?? options.storageConfigVersion,
        invocationLogSink: context.invocationLogSink ?? options.invocationLogSink,
        projectPath: options.projectPath,
        abortSignal: context.abortSignal,
        fallbackModels: options.fallbackModels,
        managedModelPolicy: options.managedModelPolicy,
      });
    },
  };
}
