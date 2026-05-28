import { randomUUID } from "node:crypto";
import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { AlwaysOnApplyInput, AlwaysOnApplyResult } from "../../gateway/protocol/types.js";
import { resolveAlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { WorkCycleStore } from "../storage/WorkCycleStore.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "./DiscoveryFire.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";

export type CreateApplyHandlerDeps = {
  gateway: Gateway;
  pilotHome: string;
  sessionOverrides: SessionConfigOverrides;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  alwaysOnConfig?: AlwaysOnConfig;
};

/**
 * Build a lightweight apply handler that does NOT depend on
 * `AlwaysOnManager` or `DiscoveryScheduler`. It reads the cycle from
 * disk and delegates to `DiscoveryFire.runApplyPhase`, which only
 * requires `gateway`, `sessionOverrides`, and the cycle record.
 */
export function createApplyHandler(
  deps: CreateApplyHandlerDeps,
): (input: AlwaysOnApplyInput) => Promise<AlwaysOnApplyResult> {
  return async (input) => {
    const paths = resolveAlwaysOnPaths({
      pilotHome: deps.pilotHome,
      projectKey: input.projectKey,
    });

    const cycleStore = new WorkCycleStore(paths);
    const cycle = await cycleStore.getRecord(input.workCycleId);
    if (!cycle) {
      return {
        sessionKey: "",
        error: { code: "cycle_not_found", message: `Work cycle ${input.workCycleId} not found` },
      };
    }

    if (!cycle.workspace?.cwd) {
      return {
        sessionKey: "",
        error: { code: "missing_workspace", message: "Cycle has no associated workspace to apply" },
      };
    }

    const planStore = new DiscoveryPlanStore(paths);
    const planIndex = await planStore.readIndex();
    const cyclePlans = planIndex.plans
      .filter((p) => cycle.planIds.includes(p.id))
      .map((p) => ({ id: p.id, title: p.title }));

    const baseConfig = deps.alwaysOnConfig ?? defaultAlwaysOnConfig();
    const minimalDeps: DiscoveryFireDependencies = {
      config: baseConfig,
      paths,
      projectKey: input.projectKey,
      gateway: deps.gateway,
      runContexts: new AlwaysOnRunContextRegistry(),
      workspaceRegistry: new WorkspaceProviderRegistry(),
      sessionOverrides: deps.sessionOverrides,
      stateStore: new DiscoveryStateStore(paths),
      planStore,
      cycleStore,
      reportStore: new DiscoveryReportStore(paths),
      eventStore: new AlwaysOnEventStore(paths),
      uuid: () => randomUUID(),
      now: () => new Date(),
      onTurnEvent: deps.onTurnEvent,
    };

    const fire = new DiscoveryFire(minimalDeps);
    const runId = randomUUID();
    const result = await fire.runApplyPhase({
      runId,
      cycle,
      plans: cyclePlans,
      projectName: input.projectName,
      projectRoot: input.projectKey,
    });

    return { sessionKey: result.sessionKey, error: result.error };
  };
}
