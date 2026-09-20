import type { AgentEventEmitter } from "../agent/protocol/events.js";
import type { CanonicalMessage } from "../model/index.js";
import {
  AutoCompactionPolicy,
  CompactionEngine,
  ContextOverflowRecovery,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  DefaultContextRuntime,
  InstructionDiscovery,
  MicroCompactionEngine,
  PromptCacheCoordinator,
  PromptContributionRegistry,
  SnipEngine,
  TokenBudgetManager,
  ToolResultBudget,
  createNativeCompactionPort,
  type CompactionPort,
  type CompactionAutomaticTriggerObservation,
  registerExtensionPromptContributions,
  type ExtensionResolver,
  type InstructionStoragePort,
  type MemoryResolver,
  type PromptCacheCoordinatorPort,
  type RuntimeContextSurface,
  type TokenAccountingRuntime,
  type ToolResultSpillPort,
} from "../context/index.js";
import type { LifecycleRuntime } from "../lifecycle/index.js";
import type { RouterRuntime } from "../router/index.js";
import type { ToolResultArtifactStorage } from "../session/index.js";

export type SessionContextRuntimeBundleOptions = {
  sessionKey: string;
  projectKey?: string;
  projectRoot: string;
  pilotHome: string;
  toolResultsDir: string;
  toolResultArtifactStorage?: ToolResultArtifactStorage;
  extension: ExtensionResolver;
  /** Preserve the selected extension catalog when a scoped agent replaces the base prompt. */
  includeExtensionsWithCustomSystemPrompt?: boolean;
  instructionStorage: InstructionStoragePort;
  toolResultSpill: ToolResultSpillPort;
  model: Pick<RouterRuntime, "stream">;
  tokenAccounting: TokenAccountingRuntime;
  lifecycle: Pick<LifecycleRuntime, "dispatch">;
  modelProvider: string;
  modelName: string;
  maxContextTokens: number;
  runtimeContextSurface?: RuntimeContextSurface;
  memoryResolver?: MemoryResolver;
  memoryRetrievalTimeoutMs?: number;
  /** Optional application-owned cache-generation provider for this session context. */
  promptCacheCoordinator?: PromptCacheCoordinatorPort;
  /** Optional application-selected compaction provider for this session context. */
  compaction?: CompactionPort;
  /** Test-only observer for the native Context automatic-compaction trigger. */
  testOnAutomaticCompactionTrigger?: (observation: CompactionAutomaticTriggerObservation) => void;
  now: () => Date;
  eventEmitter?: AgentEventEmitter;
};

export type SessionContextRuntimeBundleResult = {
  context: DefaultContextRuntime;
  /** Rebuild the Gateway-local cache for durable result references on resume. */
  hydrateToolResultReferences(messages: readonly CanonicalMessage[]): Promise<void>;
  promptContributions: {
    registry: PromptContributionRegistry;
    owned: true;
  };
};

/**
 * Native session-context composition.
 *
 * The project owns model routing, memory, instruction storage and spill I/O.
 * The Agent scope owns only the prompt-contribution registrations created from
 * the frozen extension generation returned here.
 */
export class SessionContextRuntimeBundle {
  constructor(private readonly options: SessionContextRuntimeBundleOptions) {}

  compose(): SessionContextRuntimeBundleResult {
    let automaticTrigger: CompactionAutomaticTriggerObservation | undefined;
    const toolResultBudget = new ToolResultBudget({
      toolResultsDir: this.options.toolResultsDir,
      artifactStorage: this.options.toolResultArtifactStorage,
      spillPort: this.options.toolResultSpill,
    });
    const tokenBudget = new TokenBudgetManager();
    const compactionEngine = new CompactionEngine({
      model: {
        stream: (request, signal) => this.options.model.stream(request, {
          sessionId: this.options.sessionKey,
          turnId: "compact",
          projectPath: this.options.projectKey,
          abortSignal: signal,
          isMainAgent: false,
        }),
      },
      tokenBudget,
      tokenAccounting: this.options.tokenAccounting,
      lifecycle: {
        dispatch: async (input) => {
          await this.options.lifecycle.dispatch({
            event: input.event,
            baseInput: {
              sessionId: this.options.sessionKey,
              transcriptPath: "",
              cwd: this.options.projectRoot,
              permissionMode: "default",
            },
            payload: input.payload,
            matchQuery: input.event,
          });
        },
      },
      provider: this.options.modelProvider,
      model_: this.options.modelName,
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      now: this.options.now,
      eventEmitter: this.options.eventEmitter,
      ...(this.options.testOnAutomaticCompactionTrigger
        ? {
            onPreCompact: ({ trigger, messages, preTokens }: { trigger: "manual" | "auto" | "reactive"; messages: import("../model/index.js").CanonicalMessage[]; preTokens: number }) => {
              if (trigger !== "auto" || !automaticTrigger?.fullSummaryStarted) return;
              automaticTrigger.summaryMessages = messages;
              automaticTrigger.summaryPreTokens = preTokens;
              automaticTrigger.summaryLocalEstimateTokens = tokenBudget.estimateMessagesTokens(messages);
              automaticTrigger.summaryAccountingEstimateTokens = this.options.tokenAccounting.estimateMessages(messages);
            },
          }
        : {}),
    });
    const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
    const microCompaction = new MicroCompactionEngine({
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    });
    const snipEngine = new SnipEngine({
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    });
    const overflowRecovery = new ContextOverflowRecovery();
    const compaction = this.options.compaction ?? createNativeCompactionPort({
      tokenBudget,
      autoCompactionPolicy,
      compactionEngine,
      microCompaction,
      snipEngine,
      overflowRecovery,
      onAutomaticTrigger: (observation) => {
        automaticTrigger = observation;
        this.options.testOnAutomaticCompactionTrigger?.(observation);
      },
    });
    const instructionDiscovery = new InstructionDiscovery(
      this.options.projectRoot,
      this.options.projectRoot,
      this.options.pilotHome,
      this.options.instructionStorage,
    );
    const promptContributions = new PromptContributionRegistry({
      name: `agent:${this.options.sessionKey}`,
    });
    const promptCacheCoordinator = this.options.promptCacheCoordinator ?? new PromptCacheCoordinator();

    try {
      registerExtensionPromptContributions(promptContributions, this.options.extension);
      return {
        context: new DefaultContextRuntime({
          extension: this.options.extension,
          includeExtensionsWithCustomSystemPrompt: this.options.includeExtensionsWithCustomSystemPrompt,
          promptContributions,
          promptCacheCoordinator,
          runtimeContextSurface: this.options.runtimeContextSurface,
          projectRoot: this.options.projectRoot,
          memoryResolver: this.options.memoryResolver,
          memoryRetrievalTimeoutMs: this.options.memoryRetrievalTimeoutMs,
          instructionDiscovery,
          toolResultBudget,
          compaction,
          tokenBudget,
          compactionEngine,
          autoCompactionPolicy,
          microCompaction,
          snipEngine,
          overflowRecovery,
          maxContextTokens: this.options.maxContextTokens,
          now: this.options.now,
        }),
        hydrateToolResultReferences: (messages) => toolResultBudget.hydrateReferences(messages),
        promptContributions: { registry: promptContributions, owned: true },
      };
    } catch (error) {
      promptContributions.dispose();
      throw error;
    }
  }
}
