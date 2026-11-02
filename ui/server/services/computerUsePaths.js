import path from 'node:path';
import os from 'node:os';
import { resolveConfigHome } from '@pilotdeck/config';

export function computerUseDirectory(env = process.env) {
  if (env.PILOTDECK_COMPUTER_USE_DIRECTORY) return path.resolve(env.PILOTDECK_COMPUTER_USE_DIRECTORY);
  return path.join(resolveConfigHome(env), 'computer-use');
}

export function computerUseMcpConfigPath(env = process.env) {
  return env.PILOTDECK_COMPUTER_USE_MCP_CONFIG || path.join(computerUseDirectory(env), 'mcp.yaml');
}
