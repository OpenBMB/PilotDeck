import { PermissionRuntime } from "../../permission/index.js";
import { ConcurrentToolScheduler } from "../../tool/scheduler/ConcurrentToolScheduler.js";
import { ToolRuntime } from "../../tool/execution/ToolRuntime.js";
import { createToolCapabilityPolicy } from "../../tool/registry/ToolCapabilityPolicy.js";
import { withBuiltinAgentToolDescription } from "../../tool/builtin/agent.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { AgentRuntimeScope } from "../scope/AgentRuntimeScope.js";
import { createNativeOneShotSubagentPort } from "./OneShotSubagentPort.js";
import { applySystemPromptFilters } from "./contextInheritance.js";
import { buildSubagentSystemPrompt, type SubagentDefinition } from "./builtinSubagentTypes.js";

export type SubagentRuntimeCompositionOptions = {
  definition: SubagentDefinition;
  subagentId: string;
  parentSessionId: string;
  parentConfig: AgentRuntimeConfig;
  parentDependencies: AgentRuntimeDependencies;
  resolvedModel?: { provider: string; model: string };
};

export type SubagentRuntimeComposition = {
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
  scope: AgentRuntimeScope;
  dispose(): Promise<void>;
};

/** Shared native child composition used by one-shot and continuable providers. */
export function createSubagentRuntimeComposition(
  options: SubagentRuntimeCompositionOptions,
): SubagentRuntimeComposition {
  const parentDependencies = options.parentDependencies;
  const permissionRuntime = parentDependencies.permission ?? new PermissionRuntime();
  const ownedParentScope = parentDependencies.scope ? undefined : AgentRuntimeScope.createRoot({
    router: parentDependencies.router,
    permission: permissionRuntime,
    interactionPolicy: parentDependencies.interactionPolicy,
    toolRegistry: parentDependencies.tools.registry,
    toolScheduler: parentDependencies.tools.scheduler,
    context: parentDependencies.context,
    lifecycle: parentDependencies.lifecycle,
    promptContributions: parentDependencies.promptContributions?.registry,
    elicitation: parentDependencies.elicitation,
    subagentProviders: parentDependencies.subagentProviders,
  }, {
    name: `subagent-parent:${options.parentSessionId}`,
    ownedElicitation: parentDependencies.ownedElicitation === true,
    ownedLifecycle: parentDependencies.ownedLifecycle === true,
  });
  const parentScope = parentDependencies.scope ?? ownedParentScope!;
  const inherited = parentScope.services;
  const contextOverride = parentDependencies.subagentComposition?.createContext?.(options.definition);
  const childDepth = (options.parentConfig.subagentDepth ?? 0) + 1;
  const maxSubagentDepth = options.parentConfig.maxSubagentDepth ?? 1;
  const registry = parentDependencies.tools.registry.createScopedView(
    createToolCapabilityPolicy({
      allowedTools: options.definition.allowedTools,
      disallowedTools: options.definition.disallowedTools,
      // The child may receive the continuable consumer only when the same
      // depth contract that governs the legacy `agent` tool permits another
      // descendant. A recognized native agent definition receives a local,
      // description-only shadow; third-party definitions remain inherited.
      runtimeCapabilities: childDepth < maxSubagentDepth ? ["subagent_fork"] : [],
    }),
  );
  const parentAgent = parentDependencies.tools.registry.get("agent");
  const describedChildAgent = parentAgent && withBuiltinAgentToolDescription(parentAgent, {
    maxSubagentDepth,
    subagentDepth: childDepth,
  });
  if (describedChildAgent) {
    registry.registerOrReplace(describedChildAgent);
  }
  const toolRuntime = new ToolRuntime(
    registry,
    inherited.permission,
    inherited.lifecycle,
    parentDependencies.eventEmitter,
  );
  const scheduler = new ConcurrentToolScheduler(toolRuntime, registry);
  let childScope: AgentRuntimeScope;
  try {
    childScope = parentScope.createChild({
      toolRegistry: registry,
      toolRuntime,
      toolScheduler: scheduler,
      ...(contextOverride ? { context: contextOverride } : {}),
    }, {
      name: `subagent:${options.subagentId}`,
      ownedToolRegistry: true,
      ownedContext: contextOverride !== undefined,
      blockedServices: ["elicitation"],
    });
  } catch (error) {
    registry.dispose();
    if (ownedParentScope) void ownedParentScope.dispose().catch(() => undefined);
    throw error;
  }
  const services = childScope.services;
  const config = buildSubagentRuntimeConfig(options);
  const dependencies: AgentRuntimeDependencies = {
    router: services.router,
    scope: childScope,
    permission: services.permission,
    interactionPolicy: services.interactionPolicy,
    tools: {
      scheduler: services.toolScheduler,
      registry: services.toolRegistry,
    },
    context: services.context,
    lifecycle: services.lifecycle,
    elicitation: services.elicitation,
    now: parentDependencies.now,
    uuid: parentDependencies.uuid,
    auditRecorder: parentDependencies.auditRecorder,
    tokenAccounting: parentDependencies.tokenAccounting,
    getModelMaxContextTokens: parentDependencies.getModelMaxContextTokens,
    getModelMaxOutputTokens: parentDependencies.getModelMaxOutputTokens,
    getModelTokenLimits: parentDependencies.getModelTokenLimits,
    getModelProtocol: parentDependencies.getModelProtocol,
    getModelSupportsPromptCache: parentDependencies.getModelSupportsPromptCache,
    subagentTranscript: parentDependencies.subagentTranscript,
    subagentProvider: parentDependencies.subagentProvider,
    subagentProviders: parentDependencies.subagentProviders,
    subagentComposition: parentDependencies.subagentComposition,
    ownedSubagentProvider: false,
    ownedElicitation: false,
    ownedLifecycle: false,
  };
  dependencies.oneShotSubagentPort = createNativeOneShotSubagentPort({
    config,
    dependencies,
  });
  return {
    config,
    dependencies,
    scope: childScope,
    dispose: async () => {
      const results = await Promise.allSettled([
        childScope.dispose(),
        ownedParentScope?.dispose() ?? Promise.resolve(),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose subagent runtime scope.");
      }
    },
  };
}

export function buildSubagentRuntimeConfig(
  options: Pick<
    SubagentRuntimeCompositionOptions,
    "definition" | "subagentId" | "parentConfig" | "resolvedModel"
  >,
): AgentRuntimeConfig {
  const parent = options.parentConfig;
  const explicitModel = options.resolvedModel ?? options.definition.modelOverride;
  const selected = explicitModel
    ? {
        ...(parent.subagentModel?.provider === explicitModel.provider
          && parent.subagentModel.model === explicitModel.model
          ? parent.subagentModel
          : {}),
        ...explicitModel,
      }
    : parent.subagentModel;
  const {
    maxContextTokens: _parentMaxContextTokens,
    maxOutputTokens: _parentMaxOutputTokens,
    ...parentWithoutTokenCaps
  } = parent;
  const subagentSystem = [
    buildSubagentSystemPrompt(options.definition),
    options.definition.criticalSystemReminder,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
  const filteredParentSystem = applySystemPromptFilters(
    parent.systemPrompt ?? "",
    options.definition,
  );
  const systemPrompt = filteredParentSystem.length > 0
    ? `${subagentSystem}\n\n${filteredParentSystem}`
    : subagentSystem;
  return {
    ...(selected ? parentWithoutTokenCaps : parent),
    ...(selected
      ? {
          provider: selected.provider,
          model: selected.model,
          ...(selected.modelMultimodal ? { modelMultimodal: selected.modelMultimodal } : {}),
        }
      : {}),
    runMode: isReadOnlySession(options.definition, parent) ? "ask" : parent.runMode,
    permissionMode: options.definition.permissionMode ?? parent.permissionMode,
    isSubagent: true,
    permissionContext: {
      ...parent.permissionContext,
      mode: options.definition.permissionMode ?? parent.permissionContext.mode,
      rules: {
        allow: parent.permissionContext.rules.allow,
        deny: parent.permissionContext.rules.deny,
        ask: parent.permissionContext.rules.ask,
      },
    },
    systemPrompt,
    stopOnStructuredOutput: false,
    subagentDepth: (parent.subagentDepth ?? 0) + 1,
    metadata: {
      ...(parent.metadata ?? {}),
      subagentId: options.subagentId,
      subagentType: options.definition.id,
    },
  };
}

function isReadOnlySession(
  definition: SubagentDefinition,
  parent: AgentRuntimeConfig,
): boolean {
  return definition.isReadOnly
    || parent.permissionMode === "plan"
    || parent.runMode === "ask";
}
