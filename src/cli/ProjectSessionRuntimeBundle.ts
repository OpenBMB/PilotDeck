import type { SessionConfigOverride } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  createAgentEventBuffer,
  type AgentLoopRuntimeFactory,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentInputAdmission,
  type CreateAgentSessionOptions,
  type SubagentProviderRegistry,
} from "../agent/index.js";
import {
  createReadSkillTool,
  createRequestUserChoiceTool,
  createRequestUserConfirmationTool,
  createRequestUserFormTool,
  createRequestUserInputTool,
} from "../tool/index.js";
import { withBuiltinAgentToolDescription } from "../tool/builtin/agent.js";
import { buildMcpToolWireName } from "../tool/index.js";
import { createDeferredToolSearchTool } from "../tool/builtin/searchTools.js";
import { resolveRoutedModelMaxContextTokens } from "../agent/runtime/modelContextWindow.js";
import {
  InputProcessor,
  PluginRuntimeExtensionResolver,
  type CompactionPort,
  type CompactionAutomaticTriggerObservation,
  type InstructionStoragePort,
  type MemoryResolver,
  type PromptCacheCoordinatorPort,
  type TokenAccountingRuntime,
  type ToolResultSpillPort,
} from "../context/index.js";
import type { PilotDeckLoadedPlugin, PluginRuntime, PluginSessionContributionSnapshot } from "../extension/index.js";
import {
  GatewaySessionLiveProjectionBundle,
  GatewayUserDialogChannel,
  createGatewayUserDialogJournal,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type GatewaySessionSdkConfig,
  type GatewayUserDialogStore,
} from "../gateway/index.js";
import type { McpRuntimeFactory, ProjectMcpRuntimeProvider } from "../mcp/index.js";
import type { ModelRuntime } from "../model/index.js";
import type { PermissionRuleSet } from "../permission/index.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import type { RouterRuntime } from "../router/index.js";
import type { RouterSessionCustomRouterPort } from "../router/index.js";
import {
  createAgentProjectSessionStorage,
  replayTranscriptEntries,
  type AgentTranscriptEntry,
} from "../session/index.js";
import { createSessionTitleGenerator } from "../session/title/SessionTitleGenerator.js";
import { createPromptSuggestionGenerator } from "../session/prompt/PromptSuggestionGenerator.js";
import type {
  ExecutionWorldBundle,
  PilotDeckToolDefinition,
  PilotDeckUnavailableToolDiagnostic,
  ToolRegistry,
} from "../tool/index.js";
import { SessionMcpRuntimeRegistry } from "../mcp/runtime/SessionMcpRuntimeRegistry.js";
import {
  createNativeSessionTitleProvider,
  type SessionTitlePort,
} from "../session/index.js";
import { GatewaySessionResourceLeaseBundle } from "./GatewaySessionResourceLeaseBundle.js";
import {
  SessionInteractionBundle,
  type GatewaySessionInteractionFacade,
} from "./SessionInteractionBundle.js";
import {
  SessionMcpRuntimeBundle,
  type SessionMcpRuntimeBundleOptions,
} from "./SessionMcpRuntimeBundle.js";
import { SessionToolCompositionBundle } from "./SessionToolCompositionBundle.js";
import { SessionContextRuntimeBundle } from "./SessionContextRuntimeBundle.js";
import { SessionFileHistoryBundle } from "./SessionFileHistoryBundle.js";
import { SessionPlanTodoBundle } from "./SessionPlanTodoBundle.js";
import { SessionGoalBundle } from "./SessionGoalBundle.js";
import {
  SessionSubagentContinuationBundle,
  type SessionSubagentContinuationRuntime,
} from "./SessionSubagentContinuationBundle.js";
import { SessionSubagentTranscriptBundle } from "./SessionSubagentTranscriptBundle.js";
import { SessionAgentConfigBundle } from "./SessionAgentConfigBundle.js";
import type { PilotDeckRuntimeProfile } from "./PilotDeckRuntimeProfile.js";
import type { InteractionProfile } from "../interaction/index.js";
import type { BackgroundSubagentRuntime } from "../agent/sub/BackgroundSubagentRuntime.js";
import type { ResolvedGatewayOrganizationPolicy } from "./createLocalGateway.js";
import {
  createKnowledgeModulePort,
  createKnowledgeQueryTool,
  createSkillModulePort,
  isDisabledModuleBinding,
  isExternalModuleBinding,
} from "../composition/index.js";

/**
 * The project-generation services consumed while composing one Agent session.
 * The ProjectRuntimeRegistry retains generation publication and lease state;
 * this bundle only consumes a published generation.
 */
export type ProjectSessionRuntime = {
  projectRoot: string;
  projectStorage: GatewayProjectStorageOptions;
  snapshot: PilotConfigSnapshot;
  profile: PilotDeckRuntimeProfile;
  model: ModelRuntime;
  router: RouterRuntime;
  routerSessionCustomRouters: RouterSessionCustomRouterPort;
  tools: ToolRegistry;
  mcpProvider: ProjectMcpRuntimeProvider;
  pluginRuntime: Pick<PluginRuntime, "refresh" | "acquireSessionContributions" | "getOutputStyle">;
  executionWorld: Pick<ExecutionWorldBundle, "shell" | "planStorage" | "backgroundTasks">;
  backgroundSubagents: BackgroundSubagentRuntime;
  instructionStorage: InstructionStoragePort;
  toolResultSpill: ToolResultSpillPort;
  compaction?: CompactionPort;
  promptCacheCoordinator?: PromptCacheCoordinatorPort;
  sessionTitleProvider?: SessionTitlePort;
  tokenAccounting: TokenAccountingRuntime;
  memory?: MemoryResolver;
  unavailableTools?: PilotDeckUnavailableToolDiagnostic[];
};

export type ProjectSessionPermissionRuleSet = {
  rules: PermissionRuleSet;
  release(): void | Promise<void>;
};

export type ProjectSessionRuntimeBundleResult = {
  /** Retains the exact project, plugin, MCP and permission resources used here. */
  resources: GatewaySessionResourceLeaseBundle;
  permissionRules: PermissionRuleSet;
  agentConfig: AgentRuntimeConfig;
  baseDependencies: CreateAgentSessionOptions["dependencies"];
  sessionTitleGenerator: ReturnType<typeof createSessionTitleGenerator>;
  promptSuggestionGenerator: ReturnType<typeof createPromptSuggestionGenerator>;
  /** Selected provider consumed by TurnRunner; generator remains compatibility output. */
  sessionTitleProvider: SessionTitlePort;
  /** Session-owned input admission against the exact extension lease. */
  inputProcessor: AgentInputAdmission;
  extendDependencies: (
    storage: ReturnType<typeof createAgentProjectSessionStorage>,
    entries?: readonly AgentTranscriptEntry[],
  ) => Partial<AgentRuntimeDependencies> | Promise<Partial<AgentRuntimeDependencies>>;
  configureContinuableSubagents: NonNullable<CreateAgentSessionOptions["__configure"]>;
};

export type ProjectSessionRuntimeBundleOptions = {
  context: GatewaySessionContext;
  runtime: ProjectSessionRuntime;
  sdkSessionConfig?: GatewaySessionSdkConfig;
  sdkSessionPlugins?: readonly PilotDeckLoadedPlugin[];
  sdkOutputStyleContent?: string;
  sdkMcpServers?: Readonly<Record<string, unknown>>;
  sdkThinking?: AgentRuntimeConfig["thinking"];
  userDialogStore?: GatewayUserDialogStore;
  organizationToolPolicy?: { allow: readonly string[]; deny: readonly string[] };
  organizationPolicy?: ResolvedGatewayOrganizationPolicy;
  /** Acquires the current generation lease only after composition begins. */
  acquireRuntimeLease: () => () => Promise<void>;
  acquirePermissionRuleSet: () => ProjectSessionPermissionRuleSet;
  sessionOverride?: SessionConfigOverride;
  interaction: {
    profile: InteractionProfile;
    canPrompt: boolean;
  };
  permissionMode: AgentRuntimeConfig["permissionMode"];
  additionalWorkingDirectories?: string[];
  gateway?: GatewaySessionInteractionFacade;
  sessionMcpRuntimes: SessionMcpRuntimeRegistry;
  mcpRuntimeFactory?: McpRuntimeFactory;
  preparePerSessionSpecs: NonNullable<SessionMcpRuntimeBundleOptions["preparePerSessionSpecs"]>;
  alwaysOnToolNames: readonly string[];
  permissionTimeoutMs?: number;
  elicitationTimeoutMs?: number;
  pilotHome: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  continuations: SessionSubagentContinuationRuntime & {
    readonly providers: SubagentProviderRegistry;
  };
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentConfigOverrides?: Pick<AgentRuntimeConfig, "maxContextMessages">;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  testOnAutomaticCompactionTrigger?: (observation: CompactionAutomaticTriggerObservation) => void;
  collectFileArtifacts: boolean;
  onDiagnostic?: (message: string, error?: unknown) => void;
};

/**
 * Session-level application composition for one published project generation.
 *
 * It owns only the temporary resource-lease aggregate and releases it on a
 * failed build. Project generation publication, Gateway pending state,
 * storage, AgentLoop execution and final ToolRegistry ownership remain with
 * their established owners.
 */
export class ProjectSessionRuntimeBundle {
  constructor(private readonly options: ProjectSessionRuntimeBundleOptions) {}

  async compose(): Promise<ProjectSessionRuntimeBundleResult> {
    const { context, runtime } = this.options;
    const resources = new GatewaySessionResourceLeaseBundle();
    resources.add("project runtime lease", this.options.acquireRuntimeLease());
    try {
      const permissionRuleSet = this.options.acquirePermissionRuleSet();
      resources.add("permission rule-set lease", async () => permissionRuleSet.release());

      await runtime.pluginRuntime.refresh();
      const extensionLease = runtime.pluginRuntime.acquireSessionContributions(this.options.sdkSessionPlugins);
      resources.add("plugin contribution lease", extensionLease.release);
      const skillBinding = runtime.snapshot.config.modules?.skills;
      const skillsDisabled = isDisabledModuleBinding(skillBinding);
      const externalSkillPort = isExternalModuleBinding(skillBinding)
        ? createSkillModulePort(skillBinding)
        : undefined;
      const selectedContributions = externalSkillPort
        ? await replaceSkillContributions(
            extensionLease.contributions,
            await externalSkillPort.list({ projectKey: runtime.projectRoot }),
          )
        : skillsDisabled
          ? await replaceSkillContributions(extensionLease.contributions, [])
        : extensionLease.contributions;
      const contributions = filterSessionSkills(selectedContributions, this.options.sdkSessionConfig?.skills);
      const extension = new PluginRuntimeExtensionResolver(contributions);
      const inputProcessor = new InputProcessor({ extension });
      const routerRegistration = runtime.routerSessionCustomRouters.register(
        context.sessionKey,
        contributions.routers.map(({ contribution }) => contribution.createCustomRouter()),
      );
      resources.add("session custom-router registration", async () => routerRegistration.release());

      const sessionToolComposition = await new SessionToolCompositionBundle({
        composeMcpTools: () => new SessionMcpRuntimeBundle({
          sessionKey: context.sessionKey,
          baseTools: runtime.tools,
          mcpProvider: runtime.mcpProvider,
          mcpServers: { ...contributions.mcpServers, ...this.options.sdkMcpServers },
          resources,
          perSessionRuntimes: this.options.sessionMcpRuntimes,
          maxPerSessionInstances: runtime.snapshot.config.gateway?.maxPerSessionMcpInstances ?? 5,
          createRuntime: this.options.mcpRuntimeFactory,
          preparePerSessionSpecs: this.options.preparePerSessionSpecs,
          onDiagnostic: (message, error) => this.options.onDiagnostic?.(message, error),
        }).compose(),
        extension,
        availability: { cwd: runtime.projectRoot, env: this.options.env },
        excludeTools: this.options.sessionOverride?.excludeTools,
        isAlwaysOnSession: context.sessionKey.startsWith("always-on/"),
        alwaysOnToolNames: this.options.alwaysOnToolNames,
      }).compose();
      const sessionTools = sessionToolComposition.registry;
      if (skillsDisabled && sessionTools.has("read_skill")) {
        sessionTools.unregister("read_skill");
      }
      if (externalSkillPort || Array.isArray(this.options.sdkSessionConfig?.skills)) {
        const skillByName = new Map(contributions.skills.map((skill) => [skill.name, skill]));
        if (!sessionTools.has("read_skill")) {
          throw new Error("read_skill is unavailable for this SDK skill-scoped session.");
        }
        sessionTools.replace(createReadSkillTool({
          loader: async (name) => externalSkillPort
            ? externalSkillPort.read({ name, projectKey: runtime.projectRoot })
            : skillByName.get(name)?.content,
          lister: () => contributions.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: skill.path,
          })),
        }));
      }
      const knowledgeBinding = runtime.snapshot.config.modules?.knowledge;
      if (isExternalModuleBinding(knowledgeBinding)) {
        if (sessionTools.has("knowledge_query")) {
          throw new Error("knowledge_query is already owned by this session.");
        }
        sessionTools.register(createKnowledgeQueryTool(createKnowledgeModulePort(knowledgeBinding)));
      }
      const userDialogTools = [
        ...(this.options.sdkSessionConfig?.userDialogKinds?.includes("input") ? [createRequestUserInputTool()] : []),
        ...(this.options.sdkSessionConfig?.userDialogKinds?.includes("select") ? [createRequestUserChoiceTool()] : []),
        ...(this.options.sdkSessionConfig?.userDialogKinds?.includes("confirm") ? [createRequestUserConfirmationTool()] : []),
        ...(this.options.sdkSessionConfig?.userDialogKinds?.includes("form") ? [createRequestUserFormTool()] : []),
      ];
      for (const tool of userDialogTools) {
        if (sessionTools.has(tool.name)) {
          throw new Error(`${tool.name} is already owned by this session.`);
        }
        sessionTools.register(tool);
      }
      const policyBlockedTools = blockedToolNames({
        organization: this.options.organizationToolPolicy,
        managed: this.options.sdkSessionConfig?.managedTools,
        sandbox: this.options.sdkSessionConfig?.sandbox,
        explicit: context,
        tools: sessionTools.listAll(),
      });
      for (const name of policyBlockedTools) sessionTools.unregister(name);
      const deferredTools = collectDeferredTools(
        this.options.sdkSessionConfig,
        this.options.sdkMcpServers,
        sessionTools,
        policyBlockedTools,
      );
      if (deferredTools.length > 0) {
        for (const tool of deferredTools) sessionTools.hide(tool.name);
        if (!policyBlockedTools.has("search_tools") && sessionTools.has("search_tools")) {
          throw new Error("Deferred SDK tools conflict with an existing search_tools registration.");
        }
        if (!policyBlockedTools.has("search_tools")) {
          sessionTools.register(createDeferredToolSearchTool({ registry: sessionTools, tools: deferredTools }));
          for (const name of blockedToolNames({
            organization: this.options.organizationToolPolicy,
            managed: this.options.sdkSessionConfig?.managedTools,
            sandbox: this.options.sdkSessionConfig?.sandbox,
            explicit: context,
            tools: sessionTools.listAll(),
          })) {
            sessionTools.unregister(name);
          }
        }
      }
      runtime.unavailableTools = sessionToolComposition.unavailable;

      const eventBuf = createAgentEventBuffer();
      const sessionInteraction = new SessionInteractionBundle({
        sessionKey: context.sessionKey,
        profile: this.options.interaction.profile,
        canPrompt: this.options.interaction.canPrompt,
        permissionRules: permissionRuleSet.rules.allow,
        hookSettings: contributions.hooks,
        sdkHooks: this.options.sdkSessionConfig?.hooks,
        includeHookEvents: this.options.sdkSessionConfig?.includeHookEvents,
        shell: runtime.executionWorld.shell,
        projectRoot: runtime.projectRoot,
        permissionTimeoutMs: this.options.permissionTimeoutMs,
        questionTimeoutMs: this.options.elicitationTimeoutMs,
        eventEmitter: eventBuf.emitter,
        gateway: this.options.gateway,
      });
      const lifecycle = sessionInteraction.lifecycle;
      const styleAppend = this.options.sdkOutputStyleContent?.trim();
      const sdkSessionConfig = this.options.sdkSessionConfig
        ? {
            ...this.options.sdkSessionConfig,
            appendSystemPrompt: [this.options.sdkSessionConfig.appendSystemPrompt, styleAppend]
              .filter((value): value is string => Boolean(value?.trim()))
              .join("\n\n") || undefined,
          }
        : undefined;
      const agentConfig = new SessionAgentConfigBundle({
        runtime,
        sdkSessionConfig,
        sdkThinking: this.options.sdkThinking,
        sessionOverride: this.options.sessionOverride,
        permissionRules: permissionRuleSet.rules,
        interaction: this.options.interaction,
        permissionMode: this.options.permissionMode,
        additionalWorkingDirectories: this.options.additionalWorkingDirectories,
        organizationPolicy: this.options.organizationPolicy,
        env: this.options.env,
        testAgentConfigOverrides: this.options.testAgentConfigOverrides,
      }).compose();
      // The project registry is shared across sessions. Shadow only this
      // session's agent definition so SDK and organization depth caps cannot
      // leak into another session's tool description.
      const sessionAgent = sessionTools.get("agent");
      const describedSessionAgent = sessionAgent && withBuiltinAgentToolDescription(sessionAgent, {
        maxSubagentDepth: agentConfig.maxSubagentDepth ?? 1,
        subagentDepth: agentConfig.subagentDepth ?? 0,
      });
      if (describedSessionAgent) {
        sessionTools.registerOrReplace(describedSessionAgent);
      }
      const baseDependencies: CreateAgentSessionOptions["dependencies"] = {
        router: runtime.router,
        tools: { registry: sessionTools },
        permission: sessionInteraction.permission,
        interactionPolicy: sessionInteraction.policy,
        subagentProviders: this.options.continuations.providers,
        backgroundSubagents: {
          launch: (input) => runtime.backgroundSubagents.start({
            kind: "background",
            sessionId: input.sessionId,
            parentTurnId: input.turnId,
            subagentId: input.subagentId,
            subagentType: input.subagentType,
            run: input.run,
          }),
        },
        observerSubagents: {
          launch: (input) => {
            runtime.backgroundSubagents.start({
              kind: "observer",
              sessionId: input.sessionId,
              parentTurnId: input.turnId,
              subagentId: input.observerSubagentId,
              subagentType: input.observerSubagentType,
              observedSubagentId: input.observedSubagentId,
              run: input.run,
            });
          },
        },
        interactionDeadlinePolicy: sessionInteraction.deadlinePolicy,
        ...(sessionInteraction.interactionReconnect
          ? { interactionReconnect: sessionInteraction.interactionReconnect }
          : {}),
        lifecycle,
        ownedLifecycle: true,
        now: this.options.now,
        eventEmitter: eventBuf.emitter,
        drainEvents: eventBuf.drain,
        tokenAccounting: runtime.tokenAccounting,
        getModelMaxContextTokens: (provider, model) => resolveRoutedModelMaxContextTokens({
          modelRuntime: runtime.model,
          agentModel: runtime.snapshot.config.agent.model,
          agentMaxContextTokens: runtime.snapshot.config.agent.maxContextTokens,
          provider,
          model,
        }),
        getModelMaxOutputTokens: (provider, model) => {
          try {
            return runtime.model.getCapabilities(provider, model).maxOutputTokens;
          } catch {
            return undefined;
          }
        },
        getModelTokenLimits: (provider, model) => {
          try {
            const caps = runtime.model.getCapabilities(provider, model);
            return { maxContextTokens: caps.maxContextTokens, maxOutputTokens: caps.maxOutputTokens };
          } catch {
            return undefined;
          }
        },
        getModelProtocol: (provider) => runtime.model.getProviderProtocol(provider),
        getModelSupportsPromptCache: (provider, model) => {
          try {
            return runtime.model.getCapabilities(provider, model).supportsPromptCache;
          } catch {
            return undefined;
          }
        },
      };
      const sessionTitleProvider = runtime.sessionTitleProvider ?? createNativeSessionTitleProvider({
        modelRuntime: runtime.model,
        agentModel: runtime.snapshot.config.agent.model,
      });
      const sessionTitleGenerator = sessionTitleProvider.generate;
      const promptSuggestionGenerator = createPromptSuggestionGenerator({
        modelRuntime: runtime.model,
        agentModel: runtime.snapshot.config.agent.model,
      });
      let goalSequence = 0;
      const extendDependencies = (
        storage: ReturnType<typeof createAgentProjectSessionStorage>,
        entries: readonly AgentTranscriptEntry[] = [],
      ) => {
        const agentModel = runtime.snapshot.config.agent.model;
        const caps = runtime.model.getCapabilities(agentModel.provider, agentModel.model);
        const sessionContext = new SessionContextRuntimeBundle({
          sessionKey: context.sessionKey,
          projectKey: context.projectKey,
          projectRoot: runtime.projectRoot,
          pilotHome: this.options.pilotHome,
          toolResultsDir: storage.toolResultsDir,
          toolResultArtifactStorage: storage.toolResultArtifactStorage,
          extension,
          instructionStorage: runtime.instructionStorage,
          toolResultSpill: runtime.toolResultSpill,
          compaction: runtime.compaction,
          testOnAutomaticCompactionTrigger: this.options.testOnAutomaticCompactionTrigger,
          promptCacheCoordinator: runtime.promptCacheCoordinator,
          model: runtime.router,
          tokenAccounting: runtime.tokenAccounting,
          lifecycle,
          modelProvider: agentModel.provider,
          modelName: agentModel.model,
          maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
          runtimeContextSurface: runtime.profile.runtimeContextSurface,
          memoryResolver: runtime.memory,
          memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
          now: this.options.now,
          eventEmitter: eventBuf.emitter,
        }).compose();
        const fileHistory = new SessionFileHistoryBundle({
          sessionKey: context.sessionKey,
          storage,
          now: this.options.now,
        }).compose();
        const subagentTranscript = new SessionSubagentTranscriptBundle({
          storage,
          now: this.options.now,
        }).compose();
        const subagentComposition: NonNullable<AgentRuntimeDependencies["subagentComposition"]> = {
          createContext: (definition) => {
            if (definition.memory !== "disabled" && definition.skills === undefined) return undefined;
            return new SessionContextRuntimeBundle({
              sessionKey: context.sessionKey,
              projectKey: context.projectKey,
              projectRoot: runtime.projectRoot,
              pilotHome: this.options.pilotHome,
              toolResultsDir: storage.toolResultsDir,
              toolResultArtifactStorage: storage.toolResultArtifactStorage,
              extension: new PluginRuntimeExtensionResolver(filterSessionSkills(
                contributions,
                definition.skills === "all" || definition.skills === undefined
                  ? undefined
                  : [...definition.skills],
              )),
              includeExtensionsWithCustomSystemPrompt: true,
              instructionStorage: runtime.instructionStorage,
              toolResultSpill: runtime.toolResultSpill,
              compaction: runtime.compaction,
              testOnAutomaticCompactionTrigger: this.options.testOnAutomaticCompactionTrigger,
              promptCacheCoordinator: runtime.promptCacheCoordinator,
              model: runtime.router,
              tokenAccounting: runtime.tokenAccounting,
              lifecycle,
              modelProvider: agentModel.provider,
              modelName: agentModel.model,
              maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
              runtimeContextSurface: runtime.profile.runtimeContextSurface,
              memoryResolver: definition.memory === "disabled" ? undefined : runtime.memory,
              memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
              now: this.options.now,
              eventEmitter: eventBuf.emitter,
            }).compose().context;
          },
          configureTools: (definition, registry) => {
            if (Array.isArray(definition.skills)) {
              const selected = new Set(definition.skills);
              const skills = contributions.skills.filter((skill) => selected.has(skill.name));
              if (registry.has("read_skill")) {
                registry.registerOrReplace(createReadSkillTool({
                  loader: async (name) => skills.find((skill) => skill.name === name)?.content,
                  lister: () => skills.map((skill) => ({
                    name: skill.name,
                    description: skill.description,
                    path: skill.path,
                  })),
                }));
              }
            }
            for (const name of blockedToolNames({
              organization: this.options.organizationToolPolicy,
              managed: this.options.sdkSessionConfig?.managedTools,
              sandbox: this.options.sdkSessionConfig?.sandbox,
              explicit: context,
              tools: registry.listAll(),
            })) {
              registry.unregister(name);
            }
          },
        };
        const planTodo = new SessionPlanTodoBundle({
          sessionKey: context.sessionKey,
          projectRoot: runtime.projectRoot,
          storage,
          planStorage: runtime.executionWorld.planStorage,
        }).compose();
        const goal = new SessionGoalBundle({
          sessionKey: context.sessionKey,
          storage,
          uuid: () => `${this.options.now().getTime()}-${++goalSequence}`,
        }).compose();
        const userDialog = this.options.sdkSessionConfig?.userDialogKinds?.length && this.options.gateway?.userDialogBus
          ? new GatewayUserDialogChannel({
              sessionKey: context.sessionKey,
              bus: this.options.gateway.userDialogBus,
              emit: this.options.gateway.emit,
              journal: createGatewayUserDialogJournal(storage),
              ...(this.options.userDialogStore ? createUserDialogStoreOptions({
                store: this.options.userDialogStore,
                projectRoot: runtime.projectRoot,
                pilotHome: this.options.pilotHome,
                sessionKey: context.sessionKey,
              }) : {}),
            })
          : undefined;
        return sessionContext.hydrateToolResultReferences(replayTranscriptEntries([...entries]).messages).then(() => ({
          context: sessionContext.context,
          ownedContext: true,
          promptContributions: sessionContext.promptContributions,
          fileHistory,
          fileUpdateNotifier: sessionInteraction.fileUpdateNotifier,
          subagentTranscript,
          subagentComposition,
          elicitation: sessionInteraction.elicitation,
          ownedElicitation: sessionInteraction.ownedElicitation,
          userDialog,
          planFileManager: planTodo.planFileManager,
          planTodoManager: planTodo.planTodoManager,
          goalManager: goal.goalManager,
        }));
      };
      const configureContinuableSubagents: NonNullable<CreateAgentSessionOptions["__configure"]> = (input) => {
        if (this.options.gateway) {
          new GatewaySessionLiveProjectionBundle({
            scope: input.scope,
            sessionKey: context.sessionKey,
            hookExecutionEvents: lifecycle,
            hookEventFormat: this.options.sdkSessionConfig?.includeHookEvents === true ? "sdk" : "agent_status",
            backgroundTaskCompletionEvents: runtime.executionWorld.backgroundTasks,
            emit: this.options.gateway.emit,
          }).attach();
        }
        sessionInteraction.attach(input.scope);
        const continuationDisposer = new SessionSubagentContinuationBundle({
          runtime: this.options.continuations,
        }).attach({
          handle: input.handle,
          config: input.config,
          dependencies: input.dependencies,
          projectStorage: runtime.projectStorage,
          agentLoopFactory: this.options.agentLoopFactory,
          testAgentLoopFactory: this.options.testAgentLoopFactory,
          collectFileArtifacts: this.options.collectFileArtifacts,
        });
        for (const name of blockedToolNames({
          organization: this.options.organizationToolPolicy,
          managed: this.options.sdkSessionConfig?.managedTools,
          sandbox: this.options.sdkSessionConfig?.sandbox,
          explicit: context,
          tools: input.dependencies.tools.registry.listAll(),
        })) {
          input.dependencies.tools.registry.unregister(name);
        }
        return continuationDisposer;
      };

      return {
        resources,
        permissionRules: permissionRuleSet.rules,
        agentConfig,
        baseDependencies,
        sessionTitleGenerator,
        sessionTitleProvider,
        promptSuggestionGenerator,
        inputProcessor,
        extendDependencies,
        configureContinuableSubagents,
      };
    } catch (error) {
      await resources.release().catch(() => undefined);
      throw error;
    }
  }
}

function filterSessionSkills(
  contributions: PluginSessionContributionSnapshot,
  selected: GatewaySessionSdkConfig["skills"],
): PluginSessionContributionSnapshot {
  if (!Array.isArray(selected)) return contributions;
  const names = new Set(selected);
  return Object.freeze({
    ...contributions,
    skills: Object.freeze(contributions.skills.filter((skill) => names.has(skill.name))),
  });
}

async function replaceSkillContributions(
  source: PluginSessionContributionSnapshot,
  skills: readonly PluginSessionContributionSnapshot["skills"][number][],
): Promise<PluginSessionContributionSnapshot> {
  return Object.freeze({
    ...source,
    skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
  });
}

function collectDeferredTools(
  sdk: GatewaySessionSdkConfig | undefined,
  mcpServers: Readonly<Record<string, unknown>> | undefined,
  registry: ToolRegistry,
  blockedTools: ReadonlySet<string> = new Set(),
): Array<{ name: string; description: string; searchHint?: string }> {
  const requested = [
    ...(sdk?.deferredTools ?? []).map((entry) => ({ name: entry.name, searchHint: entry.searchHint })),
    ...Object.entries(mcpServers ?? {}).flatMap(([serverName, rawConfig]) => {
      const config = rawConfig as import("../gateway/protocol/types.js").GatewayMcpServerConfig;
      return (config.deferredTools ?? []).map((entry) => ({
        name: buildMcpToolWireName(serverName, entry.name),
        searchHint: entry.searchHint,
      }));
    }),
  ];
  const result = new Map<string, { name: string; description: string; searchHint?: string }>();
  for (const entry of requested) {
    if (blockedTools.has(entry.name)) continue;
    const tool = registry.listAll().find((candidate) => candidate.name === entry.name);
    if (!tool) throw new Error(`SDK deferred tool ${entry.name} is not available in this session.`);
    result.set(entry.name, {
      name: entry.name,
      description: tool.description,
      ...(entry.searchHint ? { searchHint: entry.searchHint } : {}),
    });
  }
  return [...result.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function blockedToolNames(input: {
  organization?: { allow: readonly string[]; deny: readonly string[] };
  managed?: { allow?: readonly string[]; deny?: readonly string[] };
  sandbox?: GatewaySessionSdkConfig["sandbox"];
  explicit: Pick<GatewaySessionContext, "allowedTools" | "disallowedTools">;
  tools: readonly PilotDeckToolDefinition[];
}): Set<string> {
  const blocked = new Set<string>();
  const restrict = (policy: { allow?: readonly string[]; deny?: readonly string[] } | undefined) => {
    if (!policy) return;
    for (const tool of input.tools) {
      if (policy.deny?.some((selector) => matchesToolSelector(tool.name, selector))) {
        blocked.add(tool.name);
      } else if (policy.allow?.length && !policy.allow.some((selector) => matchesToolSelector(tool.name, selector))) {
        blocked.add(tool.name);
      }
    }
  };
  restrict(input.organization);
  restrict(input.managed);

  if (input.explicit.allowedTools !== undefined || input.explicit.disallowedTools !== undefined) {
    const allowed = new Set(input.explicit.allowedTools ?? []);
    const denied = new Set(input.explicit.disallowedTools ?? []);
    for (const tool of input.tools) {
      if ((input.explicit.allowedTools !== undefined && !allowed.has(tool.name)) || denied.has(tool.name)) {
        blocked.add(tool.name);
      }
    }
  }

  const sandbox = input.sandbox;
  if (sandbox) {
    const hostBridge = (tool: PilotDeckToolDefinition) => tool.kind === "shell"
      || tool.kind === "mcp"
      || tool.kind === "custom"
      || tool.name === "execute_code"
      || tool.name === "agent"
      || tool.name.startsWith("task_");
    for (const tool of input.tools) {
      const denyHostBridge = sandbox.process === "deny" && hostBridge(tool);
      const denyFilesystem = sandbox.filesystem === "deny"
        ? tool.kind === "filesystem" || hostBridge(tool)
        : sandbox.filesystem === "read_only" && (
          tool.name === "write_file"
          || tool.name === "edit_file"
          || tool.name === "edit_notebook"
          || hostBridge(tool)
        );
      const denyNetwork = sandbox.network === "deny" && (tool.kind === "network" || hostBridge(tool));
      if (denyHostBridge || denyFilesystem || denyNetwork) blocked.add(tool.name);
    }
  }
  return blocked;
}

function matchesToolSelector(name: string, selector: string): boolean {
  return selector === "*"
    || selector === name
    || (selector.endsWith("*") && name.startsWith(selector.slice(0, -1)));
}

const HOSTED_USER_DIALOG_OWNER_TTL_MS = 5_000;

function createUserDialogStoreOptions(input: {
  store: GatewayUserDialogStore;
  projectRoot: string;
  pilotHome: string;
  sessionKey: string;
}) {
  const storeKey = Object.freeze({
    projectRoot: input.projectRoot,
    pilotHome: input.pilotHome,
    sessionId: input.sessionKey,
  });
  return {
    store: input.store,
    storeKey,
    ...(hasLiveUserDialogStore(input.store) ? {
      takeStoredAnswer: (requestId: string) => input.store.takeLiveAnswer!(storeKey, requestId),
    } : {}),
    ...(hasLiveUserDialogOwnerStore(input.store) ? {
      claimStoredOwner: async (requestId: string, ownerId: string) => {
        const claim = await input.store.claimLiveOwner!(storeKey, {
          requestId,
          ownerId,
          ttlMs: HOSTED_USER_DIALOG_OWNER_TTL_MS,
        });
        return claim.owned;
      },
      renewStoredOwner: (requestId: string, ownerId: string) => input.store.renewLiveOwner!(storeKey, {
        requestId,
        ownerId,
        ttlMs: HOSTED_USER_DIALOG_OWNER_TTL_MS,
      }),
      releaseStoredOwner: (requestId: string, ownerId: string) => input.store.releaseLiveOwner!(storeKey, {
        requestId,
        ownerId,
      }),
    } : {}),
  };
}

function hasLiveUserDialogStore(
  store: GatewayUserDialogStore,
): store is GatewayUserDialogStore & Required<Pick<GatewayUserDialogStore, "takeLiveAnswer">> {
  return typeof store.takeLiveAnswer === "function";
}

function hasLiveUserDialogOwnerStore(
  store: GatewayUserDialogStore,
): store is GatewayUserDialogStore & Required<Pick<
  GatewayUserDialogStore,
  "claimLiveOwner" | "renewLiveOwner" | "releaseLiveOwner"
>> {
  return Boolean(store.claimLiveOwner && store.renewLiveOwner && store.releaseLiveOwner);
}
