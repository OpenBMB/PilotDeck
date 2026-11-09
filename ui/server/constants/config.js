// Ensure unified YAML config is applied before reading flags.
import '../load-env.js';
import { isLocalAuthDisabled } from '../../shared/localAuth.js';

/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * When true, skip JWT login/register in the web UI (single-user local mode).
 * Login/register is disabled by default. Set 0/false to require an account.
 * Unrecognized values keep account authentication enabled.
 * @type {boolean}
 */
export const DISABLE_LOCAL_AUTH = isLocalAuthDisabled(process.env.PILOTDECK_DISABLE_LOCAL_AUTH);
