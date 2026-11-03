import { installRuntimeLogging } from '../diagnostics/runtimeLogging.js';
export const gatewayRuntimeLogging = installRuntimeLogging('gateway', process.argv[2] === 'server');
