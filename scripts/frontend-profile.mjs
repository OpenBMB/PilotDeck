import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The browser bundle and runtime both use this profile when no profile is supplied. */
export const SAFE_NATIVE_FRONTEND_PROFILE = resolve(
  root,
  'products/pilotdeck-staffdeck-sop/profiles/native.yaml',
);

function resolveFromRoot(value, cwd = root) {
  return resolve(cwd, value);
}

export function resolveFrontendProfile({
  frontendProfile = process.env.PILOTDECK_FRONTEND_PROFILE,
  configPath = process.env.PILOTDECK_CONFIG_PATH,
  cwd = root,
} = {}) {
  const explicit = typeof frontendProfile === 'string' ? frontendProfile.trim() : '';
  const configured = typeof configPath === 'string' ? configPath.trim() : '';
  const explicitPath = explicit ? resolveFromRoot(explicit, cwd) : null;
  const configProfilePath = configured ? resolveFromRoot(configured, cwd) : null;

  if (explicitPath && configProfilePath && explicitPath !== configProfilePath) {
    throw new Error(
      `PILOTDECK_FRONTEND_PROFILE (${explicitPath}) and PILOTDECK_CONFIG_PATH (${configProfilePath}) must name the same profile.`,
    );
  }

  const path = explicitPath ?? configProfilePath ?? SAFE_NATIVE_FRONTEND_PROFILE;
  if (!existsSync(path)) throw new Error(`Frontend composition profile does not exist: ${path}`);
  return {
    path,
    source: explicitPath ? 'PILOTDECK_FRONTEND_PROFILE' : configProfilePath ? 'PILOTDECK_CONFIG_PATH' : 'safe-native-default',
  };
}
