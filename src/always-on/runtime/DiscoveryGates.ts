import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import type {
  AlwaysOnChannelLease,
  AlwaysOnDiscoveryState,
  GateResult,
} from "../protocol/types.js";

export type DiscoveryGateInput = {
  projectKey: string;
  config: AlwaysOnConfig;
  state: AlwaysOnDiscoveryState;
  leases: AlwaysOnChannelLease[];
  now: Date;
  projectExists: boolean;
  lockHeld: boolean;
  sessionInFlight?: boolean;
};

/**
 * Pure gate evaluation. Order is fixed per `02-pilotdeck-always-on-rewrite-plan.md` §11;
 * first failing gate wins. Lease list is consumed only as a *reverse* signal —
 * an empty lease list never blocks a fire; presence of a busy/recent lease
 * does. Workspace single-instance is enforced by `DiscoveryFire.ensureWorkspace`,
 * not by this gate.
 */
export function evaluateAlwaysOnDiscoveryGates(input: DiscoveryGateInput): GateResult {
  const { config, state, leases, now, projectKey } = input;

  if (!config.enabled || !config.trigger.enabled) {
    return { ok: false, reason: "disabled" };
  }

  const project = config.projects[projectKey];
  if (!project || !project.enabled) {
    return { ok: false, reason: "project_disabled" };
  }

  if (!input.projectExists) {
    return { ok: false, reason: "project_missing" };
  }

  if (config.dormancy.enabled && state.dormant) {
    return { ok: false, reason: "dormant_no_signal" };
  }

  const fresh = leases.filter((lease) => lease.projectKey === projectKey);

  if (input.sessionInFlight === true) {
    return { ok: false, reason: "agent_busy" };
  }
  if (fresh.length > 0) {
    if (fresh.some((lease) => lease.agentBusy)) {
      return { ok: false, reason: "agent_busy" };
    }

    const recentMs = config.trigger.recentUserMsgMinutes * 60_000;
    const lastUserMs = pickMostRecentLastUserMsgMs(fresh);
    if (lastUserMs !== undefined && now.getTime() - lastUserMs < recentMs) {
      return { ok: false, reason: "recent_user_msg" };
    }
  }

  const cooldownMs = config.trigger.cooldownMinutes * 60_000;
  if (state.lastFireCompletedAt) {
    const elapsed = now.getTime() - Date.parse(state.lastFireCompletedAt);
    if (elapsed < cooldownMs) {
      return { ok: false, reason: "cooldown" };
    }
  }

  if (state.todayRunCount >= config.trigger.dailyBudget) {
    return { ok: false, reason: "daily_budget" };
  }

  if (input.lockHeld) {
    return { ok: false, reason: "lock_busy" };
  }

  if (fresh.length === 0) {
    return { ok: true, lease: undefined };
  }
  const target = pickPreferredLease(fresh, config.trigger.preferChannel) ?? fresh[0];
  return { ok: true, lease: target };
}

function pickMostRecentLastUserMsgMs(leases: AlwaysOnChannelLease[]): number | undefined {
  let best: number | undefined;
  for (const lease of leases) {
    if (!lease.lastUserMsgAt) continue;
    const ms = Date.parse(lease.lastUserMsgAt);
    if (Number.isFinite(ms) && (best === undefined || ms > best)) {
      best = ms;
    }
  }
  return best;
}

function pickPreferredLease(
  leases: AlwaysOnChannelLease[],
  preferChannel: string,
): AlwaysOnChannelLease | undefined {
  return leases.find((lease) => lease.channelKey === preferChannel);
}
