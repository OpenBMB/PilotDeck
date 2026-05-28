import type { Gateway } from "../../gateway/index.js";
import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import type { CreateAlwaysOnDiscoveryPlanToolOptions } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnDiscoveryPlanTool } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnReportTool } from "../tool/AlwaysOnReportTool.js";
import { createAlwaysOnWorkspaceTool } from "../tool/AlwaysOnWorkspaceTool.js";
import { createAlwaysOnChatHistoryTool } from "../tool/AlwaysOnChatHistoryTool.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import type { DiscoveryFireDependencies } from "./DiscoveryFire.js";
import {
  AlwaysOnRuntime,
  type AlwaysOnRuntimeLogger,
} from "./AlwaysOnRuntime.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";

export type CreateAlwaysOnManagerOptions = {
  config: AlwaysOnConfig;
  pilotHome: string;
  now?: () => Date;
  uuid?: () => string;
  logger?: AlwaysOnRuntimeLogger;
  toolContractOptions?: CreateAlwaysOnDiscoveryPlanToolOptions["contract"];
  onWorktreeCreated?: (runId: string, cwd: string) => void;
  onWorktreeRemoved?: (cwd: string) => void;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
};

/**
 * Multi-project coordinator for Always-On.
 *
 * Creates one `AlwaysOnRuntime` per enabled project in the config while
 * sharing a single `AlwaysOnRunContextRegistry`, `SessionConfigOverrides`,
 * and tool set.  This ensures tool lookups by session-key work across all
 * projects and the gateway only sees one set of tool definitions.
 */
export class AlwaysOnManager {
  private readonly runtimes: AlwaysOnRuntime[] = [];
  private readonly runContexts = new AlwaysOnRunContextRegistry();
  private readonly sessionOverrides = new SessionConfigOverrides();
  private readonly tools: PilotDeckToolDefinition[];
  private readonly logger: AlwaysOnRuntimeLogger;

  constructor(private readonly options: CreateAlwaysOnManagerOptions) {
    const now = options.now ?? (() => new Date());
    const uuid = options.uuid;
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined };

    this.tools = [
      createAlwaysOnDiscoveryPlanTool({
        runContexts: this.runContexts,
        contract: options.toolContractOptions,
        now,
        uuid,
      }),
      createAlwaysOnReportTool({
        runContexts: this.runContexts,
        now,
      }),
      createAlwaysOnWorkspaceTool({
        runContexts: this.runContexts,
      }),
      createAlwaysOnChatHistoryTool({
        runContexts: this.runContexts,
      }),
    ];

    for (const [projectKey, project] of Object.entries(options.config.projects)) {
      if (!project.enabled) continue;
      this.runtimes.push(
        new AlwaysOnRuntime({
          config: options.config,
          pilotHome: options.pilotHome,
          projectKey,
          now: options.now,
          uuid: options.uuid,
          logger: options.logger,
          onWorktreeCreated: options.onWorktreeCreated,
          onWorktreeRemoved: options.onWorktreeRemoved,
          onTurnEvent: options.onTurnEvent,
          runContexts: this.runContexts,
          sessionOverrides: this.sessionOverrides,
          skipToolCreation: true,
        }),
      );
    }
  }

  getTools(): PilotDeckToolDefinition[] {
    return [...this.tools];
  }

  getSessionOverrides(): SessionConfigOverrides {
    return this.sessionOverrides;
  }

  /**
   * Bind the gateway and an optional `isProjectBusy` callback that the
   * scheduler uses to evaluate the `agent_busy` gate from real data.
   */
  bindGateway(
    gateway: Gateway,
    hooks?: { isProjectBusy?: (projectKey: string) => boolean },
  ): void {
    const isProjectBusy = hooks?.isProjectBusy;
    for (const runtime of this.runtimes) {
      const projectKey = runtime.projectKey;
      runtime.bindGateway(gateway, {
        isSessionInFlight: isProjectBusy
          ? () => isProjectBusy(projectKey)
          : undefined,
      });
    }
  }

  async start(): Promise<void> {
    for (const runtime of this.runtimes) {
      await runtime.start();
    }
    if (this.runtimes.length === 0) {
      this.logger.info("always-on manager: no enabled projects; nothing to start.");
    }
  }

  async stop(): Promise<void> {
    for (const runtime of this.runtimes) {
      await runtime.stop();
    }
  }

  async rerunPlan(input: {
    projectKey: string;
    planId: string;
  }): Promise<{ runId: string; error?: { code: string; message: string } }> {
    const runtime = this.runtimes.find((r) => r.projectKey === input.projectKey);
    if (!runtime) {
      return { runId: "", error: { code: "project_not_found", message: `No Always-On runtime for project ${input.projectKey}` } };
    }
    return runtime.rerunPlan({ planId: input.planId });
  }

  async applyCycle(input: {
    projectKey: string;
    workCycleId: string;
    projectName: string;
  }): Promise<{ sessionKey: string; error?: { code: string; message: string } }> {
    const runtime = this.runtimes.find((r) => r.projectKey === input.projectKey);
    if (!runtime) {
      return { sessionKey: "", error: { code: "project_not_found", message: `No Always-On runtime for project ${input.projectKey}` } };
    }
    return runtime.applyCycle({
      workCycleId: input.workCycleId,
      projectRoot: input.projectKey,
      projectName: input.projectName,
    });
  }
}

export function createAlwaysOnManager(
  options: CreateAlwaysOnManagerOptions,
): AlwaysOnManager {
  return new AlwaysOnManager(options);
}
