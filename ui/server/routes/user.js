import express from 'express';
import { userDb } from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { getSystemGitConfig } from '../utils/gitConfig.js';
import { readPilotDeckConfigFile } from '../services/pilotdeckConfig.js';
import { spawn } from 'child_process';

const router = express.Router();

// Sentinel api-key written by scripts/bootstrap-pilotdeck-config.mjs so the
// engine can boot. Treated as "not configured" so the UI routes to onboarding.
const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';

function hasUsablePilotDeckConfig() {
  const record = readPilotDeckConfigFile();
  if (!record.exists) return false;

  const mainRef = typeof record.config?.agent?.model === 'string'
    ? record.config.agent.model.trim()
    : '';
  if (!mainRef) return false;

  const slash = mainRef.indexOf('/');
  if (slash <= 0 || slash === mainRef.length - 1) return false;
  const providerId = mainRef.slice(0, slash);
  const modelId = mainRef.slice(slash + 1);

  const provider = record.config?.model?.providers?.[providerId];
  if (!provider || typeof provider !== 'object') return false;

  const hasUrl = typeof provider.url === 'string' && provider.url.trim();
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  const hasRealKey = Boolean(apiKey) && apiKey !== PLACEHOLDER_API_KEY;
  const hasModel = provider.models && typeof provider.models === 'object' && modelId in provider.models;

  return Boolean(hasUrl && hasRealKey && hasModel);
}

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return; }
      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let gitConfig = userDb.getGitConfig(userId);

    // If database is empty, try to get from system git config
    if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
      const systemConfig = await getSystemGitConfig();

      // If system has values, save them to database for this user
      if (systemConfig.git_name || systemConfig.git_email) {
        userDb.updateGitConfig(userId, systemConfig.git_name, systemConfig.git_email);
        gitConfig = systemConfig;
        console.log(`Auto-populated git config from system for user ${userId}: ${systemConfig.git_name} <${systemConfig.git_email}>`);
      }
    }

    res.json({
      success: true,
      gitName: gitConfig?.git_name || null,
      gitEmail: gitConfig?.git_email || null
    });
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
});

// Apply git config globally via git config --global
router.post('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    try {
      await spawnAsync('git', ['config', '--global', 'user.name', gitName]);
      await spawnAsync('git', ['config', '--global', 'user.email', gitEmail]);
      console.log(`Applied git config globally: ${gitName} <${gitEmail}>`);
    } catch (gitError) {
      console.error('Error applying git config:', gitError);
    }

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
});

router.post('/complete-onboarding', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Onboarding completed successfully'
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

router.get('/onboarding-status', authenticateToken, async (req, res) => {
  try {
    const hasCompleted = hasUsablePilotDeckConfig();

    res.json({
      success: true,
      hasCompletedOnboarding: hasCompleted
    });
  } catch (error) {
    console.error('Error checking onboarding status:', error);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

export default router;
