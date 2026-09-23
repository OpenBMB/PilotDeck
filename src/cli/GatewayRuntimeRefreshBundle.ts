import type { ProjectMemoryMaintenancePort } from "./ProjectMemoryMaintenanceController.js";
import { isRunPolicyOnlyChange } from "../pilot/config/classifyChanges.js";

export type GatewayRuntimeConfigEvent = {
  changedPaths: string[];
  changeClasses: string[];
};

export type GatewayRuntimeRefreshRouter = {
  markAllDirty(reason: string): number;
  markProjectDirty(projectKey: string, reason: string): number;
  cachedSessionCount(): number;
  snapshotSession(sessionKey: string): { messages: unknown } | undefined;
};

export type GatewayRuntimeRefreshBundleOptions = {
  configStore: {
    subscribe(listener: (event: GatewayRuntimeConfigEvent) => void): () => void;
    reload(reason?: string): Promise<unknown>;
  };
  registry: {
    reload(): Promise<void>;
    invalidate(projectKey?: string): void;
  };
  memoryMaintenance: ProjectMemoryMaintenancePort;
  getRouter: () => GatewayRuntimeRefreshRouter | undefined;
  projectRoot: string;
  memoryDiagnosticsEnabled: boolean;
  logMemoryDiagnostic: (input: Record<string, unknown>) => void;
  summarizeMessages: (messages: unknown) => Record<string, unknown>;
  dispatchSdkConfigChange?(payload: { changedPaths: string[]; changeClasses: string[] }): void;
  warn?: (message: string, error?: unknown) => void;
  log?: (message: string) => void;
};

type GatewayNotificationServer = {
  broadcastNotification(name: string, payload?: unknown): void;
};

/**
 * Application-owned config/reload composition for a local Gateway. ConfigStore,
 * ProjectRuntimeRegistry, and SessionRouter retain their own state; this bundle
 * only coordinates their existing callbacks and notification projection.
 */
export class GatewayRuntimeRefreshBundle {
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly log: (message: string) => void;
  private unsubscribe?: () => void;
  private boundServer?: GatewayNotificationServer;

  constructor(private readonly options: GatewayRuntimeRefreshBundleOptions) {
    this.warn = options.warn ?? ((message, error) => console.warn(message, error));
    this.log = options.log ?? ((message) => console.log(message));
  }

  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.configStore.subscribe((event) => this.onConfigChange(event));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.boundServer = undefined;
  }

  bindServer(server: GatewayNotificationServer): void {
    this.boundServer = server;
  }

  async reloadConfig(): Promise<{ reloaded: boolean; changedPaths: string[] }> {
    let changedPaths: string[] = [];
    const unsubscribe = this.options.configStore.subscribe((event) => {
      changedPaths = event.changedPaths;
    });
    try {
      await this.options.configStore.reload("rpc");
    } finally {
      unsubscribe();
    }
    return { reloaded: true, changedPaths };
  }

  async reloadExtensions(input?: { projectKey?: string; changedPaths?: string[] }): Promise<{
    reloaded: boolean;
    changedPaths: string[];
  }> {
    const changedPaths = input?.changedPaths ?? [];
    const router = this.options.getRouter();
    if (input?.projectKey) {
      this.log(
        `[pilotdeck] Extensions reload requested for project ${input.projectKey}: ` +
        `${changedPaths.join(", ") || "(manual)"}`,
      );
      this.options.registry.invalidate(input.projectKey);
      router?.markProjectDirty(input.projectKey, "extension_changed");
    } else {
      this.log(`[pilotdeck] Extensions reload requested for all runtimes: ${changedPaths.join(", ") || "(manual)"}`);
      this.options.registry.invalidate();
      router?.markAllDirty("extension_changed");
    }
    this.boundServer?.broadcastNotification("config_changed", {
      changedPaths,
      changeClasses: ["extension-changed"],
    });
    return { reloaded: true, changedPaths };
  }

  async refreshConfigBeforeTurn(): Promise<void> {
    await this.options.configStore.reload("turn-start");
  }

  async afterTurnCompleted(input: {
    sessionKey: string;
    projectKey?: string;
    runId?: string;
  }): Promise<void> {
    if (this.options.memoryDiagnosticsEnabled) {
      const snapshot = this.options.getRouter()?.snapshotSession(input.sessionKey);
      this.options.logMemoryDiagnostic({
        event: "turn_completed",
        sessionCount: this.options.getRouter()?.cachedSessionCount(),
        session: {
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          runId: input.runId,
          ...(snapshot ? this.options.summarizeMessages(snapshot.messages) : {}),
        },
      });
    }
    this.options.memoryMaintenance.schedule(input.projectKey ?? this.options.projectRoot);
  }

  private onConfigChange(event: GatewayRuntimeConfigEvent): void {
    const { changeClasses, changedPaths } = event;
    if (changeClasses.length === 0) return;
    if (changeClasses.every((changeClass) => changeClass === "restart-required")) {
      this.warn("[pilotdeck] Config change requires process restart:", changedPaths.join(", "));
      return;
    }
    if (isRunPolicyOnlyChange(changedPaths)) {
      this.log(`[pilotdeck] Config reloaded (runPolicy applies next turn): ${changedPaths.join(", ")}`);
      this.options.dispatchSdkConfigChange?.({ changedPaths, changeClasses });
      this.boundServer?.broadcastNotification("config_changed", { changedPaths, changeClasses });
      return;
    }
    this.log(`[pilotdeck] Config reloaded, refreshing runtimes: ${changedPaths.join(", ")}`);
    this.options.dispatchSdkConfigChange?.({ changedPaths, changeClasses });
    void this.options.registry.reload().then(() => {
      const router = this.options.getRouter();
      if (this.options.memoryDiagnosticsEnabled) {
        this.options.logMemoryDiagnostic({
          event: "runtime_invalidated",
          sessionCount: router?.cachedSessionCount(),
          projectKey: this.options.projectRoot,
          reason: "config_changed",
        });
      }
      router?.markAllDirty("config_changed");
      this.boundServer?.broadcastNotification("config_changed", { changedPaths, changeClasses });
    }, (error) => {
      this.warn("[pilotdeck] Config runtime refresh rejected; keeping previous runtimes:", error);
    });
  }
}
