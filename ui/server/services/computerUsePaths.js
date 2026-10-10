import path from 'node:path';
import os from 'node:os';

export function computerUseDirectory(env = process.env) {
  return path.join(path.resolve(env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck')), 'computer-use');
}

export function computerUseMcpConfigPath(env = process.env) {
  return env.PILOTDECK_COMPUTER_USE_MCP_CONFIG || path.join(computerUseDirectory(env), 'mcp.json');
}
