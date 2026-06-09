import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const router = express.Router();

let updateInProgress = false;
let lastUpdateResult = null;

function execInProject(cmd) {
  return execAsync(cmd, { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 });
}

/**
 * POST /api/update/check
 * Check if there are updates available (git fetch + compare HEAD)
 */
router.post('/check', async (req, res) => {
  try {
    const { stdout: branch } = await execInProject('git branch --show-current');
    const currentBranch = branch.trim() || 'main';

    await execInProject(`git fetch origin ${currentBranch}`);

    const { stdout: localHead } = await execInProject('git rev-parse HEAD');
    const { stdout: remoteHead } = await execInProject(`git rev-parse origin/${currentBranch}`);

    const local = localHead.trim();
    const remote = remoteHead.trim();
    const hasUpdate = local !== remote;

    let behindCount = 0;
    let newCommits = [];
    if (hasUpdate) {
      const { stdout: countOut } = await execInProject(
        `git rev-list --count HEAD..origin/${currentBranch}`,
      );
      behindCount = parseInt(countOut.trim(), 10) || 0;

      const { stdout: logOut } = await execInProject(
        `git log --oneline HEAD..origin/${currentBranch} -10`,
      );
      newCommits = logOut.trim().split('\n').filter(Boolean);
    }

    const { stdout: currentCommit } = await execInProject('git log --oneline -1 HEAD');

    res.json({
      hasUpdate,
      currentBranch,
      localHead: local.slice(0, 8),
      remoteHead: remote.slice(0, 8),
      behindCount,
      newCommits,
      currentCommit: currentCommit.trim(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check for updates',
      message: error.message,
    });
  }
});

/**
 * POST /api/update/apply
 * Pull latest code, rebuild, and prepare for restart.
 * Streams progress via newline-delimited JSON.
 */
router.post('/apply', async (req, res) => {
  if (updateInProgress) {
    return res.status(409).json({
      error: 'Update already in progress',
      message: 'An update is currently running. Please wait for it to complete.',
    });
  }

  updateInProgress = true;
  lastUpdateResult = null;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendProgress = (stage, message, status = 'running') => {
    const line = JSON.stringify({ stage, message, status, timestamp: Date.now() });
    res.write(line + '\n');
  };

  try {
    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'update.sh');

    sendProgress('start', 'Starting update process...');

    const child = spawn('bash', [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let exitCode = null;

    child.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        sendProgress('progress', line);
      }
    });

    child.stderr.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        sendProgress('progress', line, 'warning');
      }
    });

    exitCode = await new Promise((resolve, reject) => {
      child.on('close', (code) => resolve(code));
      child.on('error', reject);
    });

    if (exitCode === 2) {
      sendProgress('complete', 'Already up-to-date. No changes needed.', 'up-to-date');
      lastUpdateResult = { success: true, alreadyUpToDate: true };
    } else if (exitCode === 0) {
      sendProgress('complete', 'Update successful! Restart required to apply changes.', 'success');
      lastUpdateResult = { success: true, alreadyUpToDate: false, needsRestart: true };
    } else {
      throw new Error(`Update script exited with code ${exitCode}`);
    }
  } catch (error) {
    sendProgress('error', `Update failed: ${error.message}`, 'error');
    lastUpdateResult = { success: false, error: error.message };
  } finally {
    updateInProgress = false;
    res.end();
  }
});

/**
 * POST /api/update/restart
 * Restart PilotDeck by spawning a fresh process, then exiting.
 * Works in both Docker (process manager respawns) and local dev (self-respawn).
 */
router.post('/restart', async (req, res) => {
  res.json({
    message: 'Restart initiated.',
    status: 'restarting',
  });

  setTimeout(() => {
    console.log('[update] Spawning replacement process and exiting...');

    // Spawn `npm run dev` (or the same entry point) as a detached process
    const isDocker = process.env.DOCKER === '1' || process.env.container === 'docker';

    if (isDocker) {
      // In Docker, just exit — the container restart policy handles respawn
      process.exit(0);
    }

    // Local: spawn a new server process detached from this one
    const projectRoot = path.resolve(PROJECT_ROOT, '..');
    const child = spawn('bash', ['-c', `sleep 2 && cd "${projectRoot}" && npm run dev`], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    // Exit after giving the response time to flush
    setTimeout(() => process.exit(0), 500);
  }, 1000);
});

/**
 * GET /api/update/status
 * Return current update state.
 */
router.get('/status', (req, res) => {
  res.json({
    updateInProgress,
    lastUpdateResult,
  });
});

export default router;
