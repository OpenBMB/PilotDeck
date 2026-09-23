import type { EdgeClawMemoryService } from "edgeclaw-memory-core";

import {
  createEdgeClawMemoryProviderFromConfig,
  type CreateEdgeClawMemoryProviderOptions,
} from "../context/index.js";
import type { MemoryResolver } from "../context/index.js";

export type ProjectMemoryMaintenanceService = Pick<EdgeClawMemoryService, "runDueScheduledMaintenance">;
export type ProjectMemoryManagementService = Pick<EdgeClawMemoryService, "list" | "clear" | "clearSession">;

/** Application-selected project memory provider and its exact lifecycle owner. */
export type ProjectMemoryProvider = {
  memory: MemoryResolver;
  maintenance?: ProjectMemoryMaintenanceService;
  management?: ProjectMemoryManagementService;
  dispose?: () => void | Promise<void>;
};

export type ProjectMemoryProviderFactory = (
  options: CreateEdgeClawMemoryProviderOptions,
) => ProjectMemoryProvider | undefined;

export type ProjectMemoryResources = {
  memory?: MemoryResolver;
  memoryService?: ProjectMemoryMaintenanceService;
  memoryManagement?: ProjectMemoryManagementService;
};

export type ProjectMemoryBundleOptions = CreateEdgeClawMemoryProviderOptions & {
  providerFactory?: ProjectMemoryProviderFactory;
  /** @deprecated Use `providerFactory`. */
  createProvider?: typeof createEdgeClawMemoryProviderFromConfig;
};

/**
 * Project-scoped native memory provider composition. It owns only the
 * provider/service construction and exact close operation; maintenance
 * scheduling belongs to the application-owned maintenance controller.
 */
export class ProjectMemoryBundle {
  private resources: ProjectMemoryResources = {};
  private providerDisposer?: () => void | Promise<void>;
  private staged = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: ProjectMemoryBundleOptions) {}

  stage(): ProjectMemoryResources {
    if (this.staged) {
      throw new Error("ProjectMemoryBundle.stage called more than once.");
    }
    if (this.disposePromise) {
      throw new Error("ProjectMemoryBundle is already disposing.");
    }
    this.staged = true;
    const { createProvider, providerFactory, ...input } = this.options;
    const created = providerFactory
      ? providerFactory(this.options)
      : (() => {
          const native = (createProvider ?? createEdgeClawMemoryProviderFromConfig)(input);
          return native
            ? {
              memory: native.provider,
              maintenance: native.service,
              management: native.service,
              dispose: () => native.service.close(),
            }
            : undefined;
        })();
    if (created) {
      this.resources = {
        memory: created.memory,
        memoryService: created.maintenance,
        memoryManagement: created.management,
      };
      this.providerDisposer = created.dispose;
    }
    return this.resources;
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= Promise.resolve().then(async () => {
      await this.providerDisposer?.();
    });
  }
}
