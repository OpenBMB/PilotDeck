/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = import.meta.env.VITE_IS_PLATFORM === 'true';

/**
 * Matches server PILOTDECK_DISABLE_LOCAL_AUTH (injected in vite.config.js).
 */
export const DISABLE_LOCAL_AUTH = import.meta.env.VITE_DISABLE_LOCAL_AUTH === 'true';