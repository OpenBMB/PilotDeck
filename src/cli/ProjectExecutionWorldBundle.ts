import type { PilotConfigSnapshot } from "../pilot/index.js";
import { isOptionalFeatureEnabled } from "../pilot/config/optionalFeature.js";
import {
  createBuiltinRegistry,
  createNodeExecutionWorldBundle,
  type CreateBuiltinRegistryOptions,
  type ExecutionWorldBundle,
  type PilotDeckToolDefinition,
  type SandboxMode,
  type ToolRegistry,
} from "../tool/index.js";
import type { ReadSkillDeps } from "../tool/builtin/readSkill.js";
import type { PilotDeckRuntimeProfile } from "./PilotDeckRuntimeProfile.js";
import type { LspServicePort } from "../lsp/index.js";

export type ProjectExecutionWorldResources = {
  executionWorld: ExecutionWorldBundle;
  tools: ToolRegistry;
};

export type ProjectExecutionWorldBundleOptions = {
  projectRoot: string;
  snapshot: PilotConfigSnapshot;
  profile: Pick<PilotDeckRuntimeProfile, "sandboxMode">;
  now: () => Date;
  extraTools: readonly PilotDeckToolDefinition[];
  subagentIdFactory?: () => string;
  skills: ReadSkillDeps;
  /** Project-generation LSP capability consumed by the optional builtin tool. */
  lsp?: LspServicePort;
  executionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
};

/**
 * Project-scoped execution provider composition. It selects the sandboxed
 * execution world and derives the one base ToolRegistry that sessions later
 * clone/filter. Per-session MCP, extension tools, and permission policy stay
 * with their existing consumers.
 */
export class ProjectExecutionWorldBundle {
  private executionWorld?: ExecutionWorldBundle;
  private staged = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: ProjectExecutionWorldBundleOptions) {}

  stage(): ProjectExecutionWorldResources {
    if (this.staged) {
      throw new Error("ProjectExecutionWorldBundle.stage called more than once.");
    }
    if (this.disposePromise) {
      throw new Error("ProjectExecutionWorldBundle is already disposing.");
    }
    this.staged = true;
    const executionWorld = (this.options.executionWorldBundleFactory ?? createNodeExecutionWorldBundle)({
      projectRoot: this.options.projectRoot,
      now: this.options.now,
      sandboxMode: this.options.profile.sandboxMode,
    });
    this.executionWorld = executionWorld;
    const tools = createBuiltinRegistry({
      fs: executionWorld.fs,
      subprocess: executionWorld.subprocess,
      shell: executionWorld.shell,
      attachmentDelivery: executionWorld.attachmentDelivery,
      executionWorkspace: executionWorld.executionWorkspace,
      codeRuntime: executionWorld.codeRuntime,
      executionTransport: executionWorld.executionTransport,
      executeCodeSandbox: executionWorld.executeCodeSandbox,
      maxSubagentDepth: this.options.snapshot.config.agent.subagents?.maxDepth ?? 1,
      backgroundTasks: { runtime: executionWorld.backgroundTasks },
      ...(this.options.subagentIdFactory ? { agent: { uuid: this.options.subagentIdFactory } } : {}),
      readSkill: this.options.skills,
      ...(this.options.lsp ? { lsp: this.options.lsp } : {}),
      ...resolveWebSearchOptions(this.options.snapshot),
    });
    for (const tool of this.options.extraTools) {
      tools.register(tool);
    }
    return { executionWorld, tools };
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= this.executionWorld?.dispose() ?? Promise.resolve();
  }
}

function resolveWebSearchOptions(
  snapshot: PilotConfigSnapshot,
): Pick<CreateBuiltinRegistryOptions, "webSearch"> {
  const webSearch = snapshot.config.tools?.webSearch;
  if (!webSearch || !isOptionalFeatureEnabled(webSearch)) return { webSearch: false };
  return {
    webSearch: {
      ...(webSearch.provider ? { provider: webSearch.provider } : {}),
      ...(webSearch.apiKey ? { apiKey: webSearch.apiKey } : {}),
      ...(webSearch.endpoint ? { endpoint: webSearch.endpoint } : {}),
      ...(webSearch.customProvider ? { customProvider: webSearch.customProvider } : {}),
    },
  };
}
