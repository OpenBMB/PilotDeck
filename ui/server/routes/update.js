import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createWebUpdateRouter } from './webUpdate.js';
import {
  isSupervisorRestartEnabled,
  normalizeUpdateRuntimeError,
  requestSupervisorRestart,
  RESTART_EXIT_CODE,
  resolveRestartCommand,
} from '../services/updateRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const router = express.Router();

router.use(createWebUpdateRouter());

/**
 * POST /api/update/restart
 * Restart PilotDeck. In supervised source runtimes the outer supervisor
 * relaunches the full process group; direct server runs fall back to
 * self-respawn.
 */
export function createRestartHandler({
  env = process.env,
  spawnImpl = spawn,
  exit = process.exit,
  setTimeoutImpl = setTimeout,
  requestSupervisorRestartImpl = requestSupervisorRestart,
  resolveRestartCommandImpl = resolveRestartCommand,
  isSupervisorRestartEnabledImpl = isSupervisorRestartEnabled,
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
  getInstanceInfo = (req) => req.app?.locals?.restartInstanceInfo,
  log = console.log,
  error = console.error,
} = {}) {
  const createAcceptedBody = (req, restartMode) => {
    const instanceInfo = getInstanceInfo(req) || {};
    return {
      status: 'accepted',
      restartMode,
      previousInstanceId: instanceInfo.instanceId ?? null,
      previousStartedAt: instanceInfo.startedAt ?? null,
      previousPid: instanceInfo.pid ?? null,
    };
  };

  return async (req, res) => {
    try {
      log('[update] Preparing replacement process and exit...');

      const isDocker = env.DOCKER === '1' || env.container === 'docker';

      if (isDocker) {
        res.status(202).json(createAcceptedBody(req, 'docker'));
        setTimeoutImpl(() => exit(0), 500);
        return;
      }

      if (isSupervisorRestartEnabledImpl(env)) {
        requestSupervisorRestartImpl({ env });
        res.status(202).json(createAcceptedBody(req, 'supervisor'));
        setTimeoutImpl(() => exit(RESTART_EXIT_CODE), 500);
        return;
      }

      // Local: spawn a replacement process detached from this one.
      const restartCommand = await resolveRestartCommandImpl({ projectRoot, env });
      const child = spawnImpl(restartCommand.command, restartCommand.args, {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...env },
        windowsHide: platform === 'win32',
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        child.once('spawn', () => settle(resolve));
        child.once('error', (spawnError) => settle(reject, spawnError));
      });

      child.unref();

      res.status(202).json(createAcceptedBody(req, 'direct'));
      setTimeoutImpl(() => exit(0), 500);
    } catch (caughtError) {
      const message = normalizeUpdateRuntimeError(caughtError);
      error(`[update] Restart failed: ${message}`);
      res.status(500).json({
        error: 'Failed to restart PilotDeck',
        message,
      });
    }
  };
}

router.post('/restart', createRestartHandler());

export function createUpdateRouter(options = {}) {
  const restartRouter = express.Router();
  restartRouter.post('/restart', createRestartHandler(options));
  return restartRouter;
}

export default router;
