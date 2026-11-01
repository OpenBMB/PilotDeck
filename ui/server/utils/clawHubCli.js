import { createRequire } from 'node:module';
import { prepareCliSpawn } from './processSpawn.js';

/** Node resolution handles both ui/node_modules and packaged runtime/node_modules. */
export function prepareClawHubExecution(
  args,
  options,
  { moduleUrl = import.meta.url, platform = process.platform, nodePath = process.execPath } = {},
) {
  try {
    const cli = createRequire(moduleUrl).resolve('clawhub/bin/clawdhub.js');
    return {
      command: nodePath,
      args: [cli, ...args],
      options: { ...options, ...(platform === 'win32' ? { windowsHide: true } : {}) },
    };
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return prepareCliSpawn('clawhub', args, options, platform);
  }
}
