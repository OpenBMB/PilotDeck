/**
 * Thin adapter — delegates all discovery-plan business logic to
 * `src/always-on/web/DiscoveryPlanService.ts`.
 *
 * This file only wires the service's dependency injection and
 * re-exports the public API surface consumed by routes and slash
 * commands.
 */

import { isSessionActiveViaGateway as isClaudeSDKSessionActive, getPilotDeckGateway } from './pilotdeck-bridge.js';
import {
  extractProjectDirectory,
  getProjectCronJobsOverview,
  getSessions,
} from './projects.js';
import { appendAlwaysOnRunEvent } from './services/always-on-run-history.js';
import {
  appendAlwaysOnRunLog,
  appendAlwaysOnRunLogEvent,
  formatAlwaysOnPlanLogLine,
} from './services/always-on-run-logs.js';
import { resolvePilotHome, createProjectId } from './utils/pilotPaths.js';

import { DiscoveryPlanService } from '../../src/always-on/web/DiscoveryPlanService.js';
import { buildDiscoveryContext } from '../../src/always-on/web/DiscoveryPlanContext.js';
import {
  applyWorktreeToProject,
  disposeWorkspace as disposeWorkspaceImpl,
} from '../../src/always-on/workspace/WorkspaceApply.js';

// ---------------------------------------------------------------------------
// Wire dependencies for the service
// ---------------------------------------------------------------------------

function getService() {
  return new DiscoveryPlanService({
    pilotHome: resolvePilotHome(),
    createProjectId,
    paths: { extractProjectDirectory },
    sessions: { getSessions },
    activity: { isSessionActive: isClaudeSDKSessionActive },
    events: {
      appendRunEvent: appendAlwaysOnRunEvent,
      appendRunLog: appendAlwaysOnRunLog,
      appendRunLogEvent: appendAlwaysOnRunLogEvent,
      formatLogLine: formatAlwaysOnPlanLogLine,
    },
    workspace: {
      applyWorktreeChanges: applyWorktreeToProject,
      disposeWorkspace: disposeWorkspaceImpl,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getProjectDiscoveryContext(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  return buildDiscoveryContext({
    projectName,
    projectRoot,
    getProjectCronJobsOverview,
    getSessions,
    extractProjectDirectory,
  });
}

export async function getProjectDiscoveryPlansOverview(projectName) {
  return getService().getPlansOverview(projectName);
}

export async function rerunDiscoveryPlan(projectName, planId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getPilotDeckGateway();
  const result = await gw.alwaysOnRerunPlan({
    projectKey: projectRoot,
    planId,
    projectName,
  });
  if (result.error) {
    const err = new Error(result.error.message);
    err.code = result.error.code;
    throw err;
  }
  return { runId: result.runId };
}

export async function getProjectDiscoveryPlanReport(projectName, planId) {
  return getService().readReport(projectName, planId);
}

export async function getProjectWorkCycles(projectName) {
  return getService().getCyclesOverview(projectName);
}

export async function archiveWorkCycle(projectName, cycleId) {
  return getService().archiveCycle(projectName, cycleId);
}

export async function applyWorkCycle(projectName, cycleId) {
  const result = await getService().queueCycleApply(projectName, cycleId);

  const gw = await getPilotDeckGateway();

  let applyResult;
  try {
    applyResult = await gw.alwaysOnApply({
      projectKey: result.projectRoot,
      workCycleId: cycleId,
      projectName,
    });
  } catch (err) {
    await getService().updateCycleExecution(projectName, cycleId, {
      status: 'failed',
    });
    return {
      cycle: result.cycle,
      error: { code: 'apply_error', message: (err && err.message) || 'Apply failed' },
    };
  }

  if (applyResult.error) {
    await getService().updateCycleExecution(projectName, cycleId, {
      status: 'failed',
    });
    return { cycle: result.cycle, error: applyResult.error };
  }

  const finalResult = await getService().updateCycleExecution(projectName, cycleId, {
    status: 'completed',
    executionSessionId: applyResult.sessionKey,
  });
  return {
    cycle: finalResult.cycle,
    sessionKey: applyResult.sessionKey,
  };
}
