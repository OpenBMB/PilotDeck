import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  applyConfigToProcessEnv,
  getPilotDeckConfigPath,
  readPilotDeckConfigFile,
} from './services/pilotdeckConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../..');

// EDGECLAW_API_BASE_URL / EDGECLAW_API_KEY / EDGECLAW_MODEL used to be
// required here, but no code in ui/ actually consumes those variables —
// chat execution goes through pilotdeck-bridge.js → src/gateway, which
// reads ~/.pilotdeck/pilotdeck.yaml directly. The sanity check has been
// retired; ui/server boots even when the config file is missing.
// ─── Auto-bootstrap ──────────────────────────────────────────────────────────
// On first run the ~/.pilotdeck/pilotdeck.yaml config file doesn't exist yet.
// Rather than relying solely on npm `pre` hooks (which are skipped when the
// server is started directly, e.g. `node server/index.js` or `pilotdeck start`),
// we run the bootstrap script inline whenever the config is missing.
// This ensures Windows users always get the folder + placeholder config
// regardless of how they launch the project.

function ensurePilotDeckConfigExists() {
  if (hasPilotDeckConfigFile()) return;

  const bootstrapScript = path.resolve(REPO_ROOT, 'scripts', 'bootstrap-pilotdeck-config.mjs');
  if (!fs.existsSync(bootstrapScript)) return;

  try {
    execSync(`node "${bootstrapScript}"`, {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      timeout: 30000,
      windowsHide: true,
    });
  } catch (err) {
    console.warn('[load-env] Config bootstrap warning:', err instanceof Error ? err.message : String(err));
  }
}

function applyDerivedRuntimeEnv() {
  const { config } = readPilotDeckConfigFile();
  applyConfigToProcessEnv(config);
}

export function getRepoRootDir() {
  return REPO_ROOT;
}

export function getPilotDeckConfigFilePath() {
  return getPilotDeckConfigPath();
}

export function hasPilotDeckConfigFile() {
  return fs.existsSync(getPilotDeckConfigPath());
}

// Stub for the deprecated boot-time sanity check. Kept as a named export
// so existing callers (e.g. ui/server/index.js) don't need a coordinated
// removal; the function is now a no-op that returns the empty list of
// missing keys.
export function assertRequiredPilotDeckEnv() {
  return [];
}

export function loadRootPilotDeckEnv() {
  ensurePilotDeckConfigExists();
  applyDerivedRuntimeEnv();

  if (!process.env.DATABASE_PATH) {
    process.env.DATABASE_PATH = path.join(process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck'), 'auth.db');
  }

  return hasPilotDeckConfigFile();
}

loadRootPilotDeckEnv();
