import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  cancelDesktopUpdateDownload,
  getDesktopDownloadStatus,
  getDesktopUpdateStatus,
  launchDownloadedDesktopUpdate,
  listDesktopReleases,
  startDesktopUpdateDownload,
} from '../services/desktopUpdateService.js';
import {
  normalizeUpdateRuntimeError,
  resolveBashExecutable,
  resolveRestartCommand,
} from '../services/updateRuntime.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const router = express.Router();

let updateInProgress = false;
let lastUpdateResult = null;

function execInProject(cmd) {
  return execAsync(cmd, { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 });
}

function execGit(args) {
  return execFileAsync('git', args, { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 });
}

function parseUpstreamRef(value) {
  const upstream = String(value || '').trim();
  const slashIndex = upstream.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= upstream.length - 1) return null;
  return {
    remote: upstream.slice(0, slashIndex),
    remoteBranch: upstream.slice(slashIndex + 1),
    ref: upstream,
  };
}

function unavailableUpdateCheck(res, {
  currentBranch = 'unknown',
  localHead = '',
  currentCommit = '',
  message,
}) {
  return res.json({
    hasUpdate: false,
    currentBranch,
    localHead: localHead ? localHead.slice(0, 8) : 'unknown',
    remoteHead: '',
    behindCount: 0,
    newCommits: [],
    currentCommit,
    checkUnavailable: true,
    message,
  });
}

/**
 * POST /api/update/check
 * Check if there are updates available (git fetch + compare HEAD)
 */
router.post('/check', async (req, res) => {
  if (req.body?.scope === 'desktop' || req.query.scope === 'desktop') {
    const force = req.body?.force === true || req.query.force === '1';
    const status = await getDesktopUpdateStatus({ force });
    return res.json(toLegacyCompatibleDesktopStatus(status));
  }

  try {
    let currentBranch = 'unknown';
    let localHead = '';
    let currentCommit = '';

    try {
      const { stdout: branch } = await execGit(['branch', '--show-current']);
      currentBranch = branch.trim() || 'HEAD';

      const { stdout: head } = await execGit(['rev-parse', 'HEAD']);
      localHead = head.trim();

      const { stdout: commit } = await execGit(['log', '--oneline', '-1', 'HEAD']);
      currentCommit = commit.trim();
    } catch (error) {
      return unavailableUpdateCheck(res, {
        currentBranch,
        localHead,
        currentCommit,
        message: `Git version check unavailable: ${error.message}`,
      });
    }

    let upstream = null;
    try {
      const { stdout } = await execGit([
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{u}',
      ]);
      upstream = parseUpstreamRef(stdout);
    } catch {
      upstream = null;
    }

    if (!upstream && currentBranch !== 'HEAD' && currentBranch !== 'unknown') {
      upstream = {
        remote: 'origin',
        remoteBranch: currentBranch,
        ref: `origin/${currentBranch}`,
      };
    }

    if (!upstream) {
      return unavailableUpdateCheck(res, {
        currentBranch,
        localHead,
        currentCommit,
        message: 'No upstream branch is configured for update checks.',
      });
    }

    try {
      await execGit([
        'fetch',
        upstream.remote,
        `${upstream.remoteBranch}:refs/remotes/${upstream.remote}/${upstream.remoteBranch}`,
      ]);
    } catch (error) {
      return unavailableUpdateCheck(res, {
        currentBranch,
        localHead,
        currentCommit,
        message: `Unable to fetch ${upstream.ref}: ${error.message}`,
      });
    }

    const { stdout: remoteHead } = await execGit(['rev-parse', upstream.ref]);

    const local = localHead.trim();
    const remote = remoteHead.trim();
    const hasUpdate = local !== remote;

    let behindCount = 0;
    let newCommits = [];
    if (hasUpdate) {
      const { stdout: countOut } = await execGit([
        'rev-list',
        '--count',
        `HEAD..${upstream.ref}`,
      ]);
      behindCount = parseInt(countOut.trim(), 10) || 0;

      const { stdout: logOut } = await execGit([
        'log',
        '--oneline',
        `HEAD..${upstream.ref}`,
        '-10',
      ]);
      newCommits = logOut.trim().split('\n').filter(Boolean);
    }

    res.json({
      hasUpdate,
      currentBranch,
      localHead: local.slice(0, 8),
      remoteHead: remote.slice(0, 8),
      behindCount,
      newCommits,
      currentCommit,
      upstream: upstream.ref,
    });
  } catch (error) {
    return unavailableUpdateCheck(res, {
      message: `Failed to check for updates: ${error.message}`,
    });
  }
});

/**
 * GET /api/update/desktop/status
 * Return desktop-app version status backed by GitHub Releases.
 */
router.get('/desktop/status', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const status = await getDesktopUpdateStatus({ force });
  res.json(status);
});

/**
 * POST /api/update/desktop/check
 * Force-check the latest desktop release.
 */
router.post('/desktop/check', async (_req, res) => {
  const status = await getDesktopUpdateStatus({ force: true });
  res.json(status);
});

/**
 * GET /api/update/desktop/releases
 * Return recent GitHub Release notes for the desktop About page.
 */
router.get('/desktop/releases', async (req, res) => {
  try {
    const limit = req.query.limit;
    const includePrerelease = req.query.includePrerelease === undefined
      ? undefined
      : req.query.includePrerelease === '1' || req.query.includePrerelease === 'true';
    const payload = await listDesktopReleases({ limit, includePrerelease });
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      error: 'Failed to fetch desktop releases',
      message: error.message,
    });
  }
});

/**
 * POST /api/update/desktop/download
 * Start downloading the selected desktop installer asset.
 */
router.post('/desktop/download', async (req, res) => {
  try {
    const download = await startDesktopUpdateDownload({
      force: req.body?.force === true,
      assetId: req.body?.assetId,
      assetName: req.body?.assetName,
      platform: req.body?.platform,
      arch: req.body?.arch,
    });
    res.status(202).json({ success: true, download });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: 'Failed to start desktop update download',
      message: error.message,
    });
  }
});

/**
 * GET /api/update/desktop/download/status
 * Poll desktop installer download progress.
 */
router.get('/desktop/download/status', (_req, res) => {
  res.json({ download: getDesktopDownloadStatus() });
});

/**
 * POST /api/update/desktop/download/cancel
 * Cancel an in-flight desktop installer download.
 */
router.post('/desktop/download/cancel', (_req, res) => {
  res.json(cancelDesktopUpdateDownload());
});

/**
 * POST /api/update/desktop/install
 * Launch the downloaded installer through the OS shell.
 */
router.post('/desktop/install', (req, res) => {
  try {
    const result = launchDownloadedDesktopUpdate({ filePath: req.body?.filePath });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: 'Failed to launch desktop update installer',
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
    const bashExecutable = await resolveBashExecutable();

    sendProgress('start', 'Starting update process...');

    const child = spawn(bashExecutable, [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
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
    const message = normalizeUpdateRuntimeError(error);
    sendProgress('error', `Update failed: ${message}`, 'error');
    lastUpdateResult = { success: false, error: message };
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

  setTimeout(async () => {
    try {
      console.log('[update] Spawning replacement process and exiting...');

      // Spawn `npm run dev` (or the same entry point) as a detached process
      const isDocker = process.env.DOCKER === '1' || process.env.container === 'docker';

      if (isDocker) {
        // In Docker, just exit — the container restart policy handles respawn
        process.exit(0);
      }

      // Local: spawn a new server process detached from this one
      const projectRoot = PROJECT_ROOT;
      const restartCommand = await resolveRestartCommand({ projectRoot });
      const child = spawn(restartCommand.command, restartCommand.args, {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
        windowsHide: process.platform === 'win32',
      });
      child.unref();

      // Exit after giving the response time to flush
      setTimeout(() => process.exit(0), 500);
    } catch (error) {
      console.error(`[update] Restart failed: ${normalizeUpdateRuntimeError(error)}`);
    }
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
    desktopDownload: getDesktopDownloadStatus(),
  });
});

function toLegacyCompatibleDesktopStatus(status) {
  const releaseSummary = status.latest
    ? [status.latest.tagName, status.latest.name].filter(Boolean).join(' ')
    : '';
  return {
    ...status,
    currentBranch: 'desktop',
    localHead: status.current?.version || 'unknown',
    remoteHead: status.latest?.version || '',
    behindCount: status.hasUpdate ? 1 : 0,
    newCommits: releaseSummary ? [releaseSummary] : [],
    currentCommit: status.current?.commit || '',
    hasUpdate: status.hasUpdate,
  };
}

export default router;
