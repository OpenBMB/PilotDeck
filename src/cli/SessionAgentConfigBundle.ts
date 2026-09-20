import type { SessionConfigOverride } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AgentRuntimeConfig } from "../agent/index.js";
import type { SubagentDefinition } from "../agent/sub/builtinSubagentTypes.js";
import type { ModelRuntime, MultimodalConstraints } from "../model/index.js";
import { createDefaultPermissionContext, permissionEntryToRule, type PermissionRuleSet } from "../permission/index.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import type { InteractionProfile } from "../interaction/index.js";
import type { PilotDeckRuntimeProfile } from "./PilotDeckRuntimeProfile.js";
import type { GatewaySessionSdkConfig } from "../gateway/protocol/types.js";
import type { ResolvedGatewayOrganizationPolicy } from "./createLocalGateway.js";

export type SessionAgentConfigRuntime = {
  projectRoot: string;
  snapshot: PilotConfigSnapshot;
  /** Immutable provider selections frozen with this project generation. */
  profile: Pick<PilotDeckRuntimeProfile, "runtimeContextSurface">;
  model: ModelRuntime;
};

export type SessionAgentConfigBundleOptions = {
  runtime: SessionAgentConfigRuntime;
  sessionOverride?: SessionConfigOverride;
  sdkSessionConfig?: GatewaySessionSdkConfig;
  sdkThinking?: AgentRuntimeConfig["thinking"];
  permissionRules: PermissionRuleSet;
  interaction: Pick<InteractionProfile, "canPrompt">;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  additionalWorkingDirectories?: string[];
  organizationPolicy?: ResolvedGatewayOrganizationPolicy;
  env: Record<string, string | undefined>;
  /** Internal parity-test override; production configuration remains unchanged. */
  testAgentConfigOverrides?: Pick<AgentRuntimeConfig, "maxContextMessages">;
};

/**
 * Builds the immutable AgentRuntimeConfig consumed by one session.
 *
 * This is a data-plane consumer: model capability lookups, permission policy
 * and session overrides remain owned by their providers. It creates no model,
 * permission, session, or AgentLoop state.
 */
export class SessionAgentConfigBundle {
  constructor(private readonly options: SessionAgentConfigBundleOptions) {}

  compose(): AgentRuntimeConfig {
    const { runtime, sessionOverride, permissionRules } = this.options;
    const agent = runtime.snapshot.config.agent;
    const sdk = this.options.sdkSessionConfig;
    const organizationPermissions = this.options.organizationPolicy?.permissions;
    const permissionMode = organizationPermissions?.defaultMode
      ?? sdk?.managedPermissions?.defaultMode
      ?? (sdk?.permissionMode === "dontAsk"
        ? "default"
        : sessionOverride?.permissionMode ?? this.options.permissionMode);
    const cwd = sessionOverride?.cwd ?? runtime.projectRoot;
    const requestedModel = resolveSdkModel(sdk?.settings?.agent?.model, agent.model);
    const organizationSettings = this.options.organizationPolicy?.settings;
    const sessionSubagents = sdk?.settings?.agent?.subagents;

    let modelMultimodal: MultimodalConstraints | undefined;
    try {
      modelMultimodal = runtime.model.getMultimodal(requestedModel.provider, requestedModel.model);
    } catch {
      // Model or provider not found: retain the text-only compatibility path.
    }

    let maxContextTokens: number | undefined;
    let maxOutputTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(requestedModel.provider, requestedModel.model);
      maxContextTokens = sdk?.settings?.agent?.maxContextTokens ?? agent.maxContextTokens ?? caps.maxContextTokens;
      maxOutputTokens = caps.maxOutputTokens;
    } catch {
      maxContextTokens = sdk?.settings?.agent?.maxContextTokens ?? agent.maxContextTokens;
    }
    maxOutputTokens = readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
      ?? sdk?.settings?.agent?.maxOutputTokens
      ?? agent.maxOutputTokens
      ?? maxOutputTokens;

    maxContextTokens = capNumber(maxContextTokens, organizationSettings?.maxContextTokens);
    maxOutputTokens = capNumber(maxOutputTokens, organizationSettings?.maxOutputTokens);

    const subagentModel = sessionSubagents && Object.prototype.hasOwnProperty.call(sessionSubagents, "default")
      ? (sessionSubagents.default === null ? undefined : resolveSdkModel(sessionSubagents.default, requestedModel))
      : agent.subagents?.default;
    let subagentRuntimeModel: AgentRuntimeConfig["subagentModel"];
    if (subagentModel) {
      let subagentModelMultimodal: MultimodalConstraints | undefined;
      try {
        subagentModelMultimodal = runtime.model.getMultimodal(
          subagentModel.provider,
          subagentModel.model,
        );
      } catch {
        // Keep the explicit subagent model when the provider is unavailable.
      }
      let subagentMaxContextTokens: number | undefined;
      let subagentMaxOutputTokens: number | undefined;
      try {
        const caps = runtime.model.getCapabilities(subagentModel.provider, subagentModel.model);
        subagentMaxContextTokens = caps.maxContextTokens;
        subagentMaxOutputTokens = caps.maxOutputTokens;
      } catch {
        // Keep the override even when optional capability metadata is absent.
      }
      subagentRuntimeModel = {
        provider: subagentModel.provider,
        model: subagentModel.model,
        ...(subagentModelMultimodal ? { modelMultimodal: subagentModelMultimodal } : {}),
        ...(subagentMaxContextTokens !== undefined ? { maxContextTokens: subagentMaxContextTokens } : {}),
        ...(subagentMaxOutputTokens !== undefined
          ? {
              maxOutputTokens: readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
                ?? subagentMaxOutputTokens,
            }
          : {}),
      };
    }

    return {
      provider: requestedModel.provider,
      model: requestedModel.model,
      ...(resolveFallbackModel(sdk, requestedModel, organizationSettings?.enforcedSessionSettings?.agent?.fallbackModel)
        ? { fallbackModels: [resolveFallbackModel(sdk, requestedModel, organizationSettings?.enforcedSessionSettings?.agent?.fallbackModel)!] }
        : {}),
      ...(sdk?.managedModels ? { managedModelPolicy: structuredClone(sdk.managedModels) } : {}),
      ...(sdk?.agentProgressSummaries === true ? { includeToolProgress: true } : {}),
      modelMultimodal,
      cwd,
      permissionMode,
      ...(sdk?.systemPrompt !== undefined ? { systemPrompt: sdk.systemPrompt } : {}),
      ...(sdk?.appendSystemPrompt !== undefined ? { appendSystemPrompt: sdk.appendSystemPrompt } : {}),
      ...(sdk?.planModeInstructions !== undefined ? { planModeInstructions: sdk.planModeInstructions } : {}),
      ...(sdk?.toolAliases ? { toolAliases: { ...sdk.toolAliases } } : {}),
      ...(sdk?.outputFormat ? { stopOnStructuredOutput: true } : {}),
      ...(sdk?.agents ? { subagentDefinitions: toSdkSubagentDefinitions(sdk.agents, this.options.organizationPolicy?.limits?.maxTurns) } : {}),
      jsonSelfCorrect: true,
      ...(subagentRuntimeModel ? { subagentModel: subagentRuntimeModel } : {}),
      subagentTimeoutMs: capNumber(
        sessionSubagents?.timeoutMs ?? agent.subagents?.timeoutMs,
        organizationSettings?.maxSubagentTimeoutMs,
      ),
      maxSubagentDepth: capSubagentDepth(
        sessionSubagents?.maxDepth ?? agent.subagents?.maxDepth,
        this.options.organizationPolicy?.limits?.maxSubagentDepth,
      ),
      maxContextTokens,
      ...(this.options.testAgentConfigOverrides ?? {}),
      maxOutputTokens,
      runtimeContextSurface: runtime.profile.runtimeContextSurface,
      ...(runtime.snapshot.config.modules?.sop ? { staffDeckSop: runtime.snapshot.config.modules.sop } : {}),
      ...(runtime.snapshot.config.modules ? {
        agentLoopBinding: runtime.snapshot.config.modules.agentLoop,
        moduleBindings: {
          modelProvider: runtime.snapshot.config.modules.modelProvider,
          tools: runtime.snapshot.config.modules.tools,
          context: runtime.snapshot.config.modules.context,
        },
      } : {}),
      thinking: capThinking(
        organizationSettings?.enforcedSessionSettings?.agent?.thinking
          ?? this.options.sdkThinking
          ?? sdk?.settings?.agent?.thinking
          ?? agent.thinking,
        organizationSettings?.maxThinkingTokens,
      ),
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: permissionMode,
        canPrompt: this.options.interaction.canPrompt
          && organizationPermissions?.canPrompt !== false
          && sdk?.managedPermissions?.canPrompt !== false
          && sdk?.permissionMode !== "dontAsk",
        policyCanPrompt: organizationPermissions?.canPrompt === false || sdk?.managedPermissions?.canPrompt === false
          ? false
          : undefined,
        acceptEdits: sdk?.permissionMode === "acceptEdits",
        bypassAvailable: sessionOverride?.bypassAvailable ?? true,
        additionalWorkingDirectories: [...new Set([
          ...(this.options.additionalWorkingDirectories ?? []),
          ...(sdk?.additionalWorkingDirectories ?? []),
        ])],
        rules: {
          allow: permissionRules.allow,
          deny: [
            ...toPolicyRules(organizationPermissions?.deny, "deny"),
            ...toPolicyRules(sdk?.managedPermissions?.deny, "deny"),
            ...permissionRules.deny,
          ],
          ask: [
            ...toPolicyRules(organizationPermissions?.ask, "ask"),
            ...toPolicyRules(sdk?.managedPermissions?.ask, "ask"),
            ...permissionRules.ask,
          ],
        },
      }),
    };
  }
}

function toSdkSubagentDefinitions(
  agents: NonNullable<GatewaySessionSdkConfig["agents"]>,
  maxTurnsCap?: number,
): Record<string, SubagentDefinition> {
  return Object.fromEntries(Object.entries(agents).map(([id, agent]) => {
    const modelOverride = agent.model ? resolveSdkModel(agent.model, { provider: "", model: "" }) : undefined;
    const mcpServers = agent.mcpServers as Record<string, import("../gateway/protocol/types.js").GatewayMcpServerConfig> | undefined;
    return [id, {
      id,
      description: agent.description,
      systemPromptSuffix: agent.prompt,
      allowedTools: agent.tools ? [...agent.tools] : ["*"],
      ...(agent.disallowedTools?.length ? { disallowedTools: [...agent.disallowedTools] } : {}),
      omitProjectInstructions: false,
      omitGitStatus: false,
      isReadOnly: agent.permissionMode === "plan",
      ...(modelOverride?.provider && modelOverride.model ? { modelOverride } : {}),
      ...(agent.maxTurns !== undefined || maxTurnsCap !== undefined
        ? { maxTurns: maxTurnsCap === undefined ? agent.maxTurns : Math.min(agent.maxTurns ?? maxTurnsCap, maxTurnsCap) }
        : {}),
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      ...(agent.permissionMode !== undefined ? { permissionMode: agent.permissionMode } : {}),
      ...(mcpServers ? { mcpServers: structuredClone(mcpServers) } : {}),
      ...(agent.skills !== undefined ? { skills: agent.skills === "all" ? "all" : [...agent.skills] } : {}),
      ...(agent.memory !== undefined ? { memory: agent.memory } : {}),
      ...(agent.initialPrompt !== undefined ? { initialPrompt: agent.initialPrompt } : {}),
      ...(agent.background === true ? { background: true } : {}),
      ...(agent.observer !== undefined ? { observer: agent.observer } : {}),
      ...(agent.observerMessage?.trim() ? { observerMessage: agent.observerMessage.trim() } : {}),
      ...(agent.criticalSystemReminder_EXPERIMENTAL !== undefined
        ? { criticalSystemReminder: agent.criticalSystemReminder_EXPERIMENTAL }
        : {}),
    }];
  }));
}

function resolveSdkModel(
  requested: string | null | undefined,
  fallback: { provider: string; model: string },
): { provider: string; model: string } {
  if (!requested) return fallback;
  const slash = requested.indexOf("/");
  if (slash <= 0 || slash === requested.length - 1) return fallback;
  return { provider: requested.slice(0, slash), model: requested.slice(slash + 1) };
}

function resolveFallbackModel(
  sdk: GatewaySessionSdkConfig | undefined,
  parent: { provider: string; model: string },
  enforced: string | null | undefined,
): { provider: string; model: string } | undefined {
  const value = enforced !== undefined
    ? enforced
    : sdk?.fallbackModel ?? sdk?.settings?.agent?.fallbackModel;
  if (value === null || value === undefined) return undefined;
  return resolveSdkModel(value, parent);
}

function capNumber(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  return value === undefined ? cap : Math.min(value, cap);
}

function capSubagentDepth(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  return Math.min(value ?? 1, cap);
}

function capThinking(
  value: AgentRuntimeConfig["thinking"] | undefined,
  cap: number | undefined,
): AgentRuntimeConfig["thinking"] | undefined {
  if (cap === undefined || value?.enabled !== true) return value;
  if (cap === 0) return { enabled: false, mode: "off" };
  return { ...value, budgetTokens: value.budgetTokens === undefined ? cap : Math.min(value.budgetTokens, cap) };
}

function toPolicyRules(
  entries: readonly string[] | undefined,
  behavior: "deny" | "ask",
) {
  return (entries ?? []).map((entry) => ({
    ...permissionEntryToRule(entry, "deny", "policy"),
    behavior,
  }));
}

function readPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}
