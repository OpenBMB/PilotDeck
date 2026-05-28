import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
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
  applyDerivedRuntimeEnv();

  if (!process.env.DATABASE_PATH) {
    process.env.DATABASE_PATH = path.join(process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck'), 'auth.db');
  }

  return hasPilotDeckConfigFile();
}

loadRootPilotDeckEnv();
