import fsPromises from 'fs/promises';
import path from 'path';
import { isVirtualProjectPath, resolvePilotHome } from '../utils/pilotPaths.js';

const DEFAULT_MCP_CONFIG = {
  mcpServers: {},
};

function pilotHome() {
  return resolvePilotHome(process.env);
}

export function getGlobalMcpConfigPath() {
  return path.join(pilotHome(), 'mcp.json');
}

export function getProjectMcpConfigPath(projectPath) {
  return path.join(projectPath, '.pilotdeck', 'mcp.json');
}

export function normalizeMcpConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MCP config root must be an object.');
  }
  if (input.mcpServers === undefined) {
    return { ...input, mcpServers: {} };
  }
  if (!input.mcpServers || typeof input.mcpServers !== 'object' || Array.isArray(input.mcpServers)) {
    throw new Error('mcpServers must be an object.');
  }
  for (const [name, server] of Object.entries(input.mcpServers)) {
    if (!name || !server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error(`Server "${name}" must be an object.`);
    }
    if (typeof server.command !== 'string' && typeof server.url !== 'string' && typeof server.httpUrl !== 'string') {
      throw new Error(`Server "${name}" must define command, url, or httpUrl.`);
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string'))) {
      throw new Error(`Server "${name}" args must be an array of strings.`);
    }
    if (server.env !== undefined && !isStringRecord(server.env)) {
      throw new Error(`Server "${name}" env must be an object with string values.`);
    }
    if (server.headers !== undefined && !isStringRecord(server.headers)) {
      throw new Error(`Server "${name}" headers must be an object with string values.`);
    }
  }
  return input;
}

export async function readMcpConfigFile(scope, projectPath) {
  if (scope === 'project' && (!projectPath || isVirtualProjectPath(projectPath, pilotHome()))) {
    return {
      exists: false,
      path: null,
      raw: JSON.stringify(DEFAULT_MCP_CONFIG, null, 2),
      config: DEFAULT_MCP_CONFIG,
      disabled: true,
      reason: 'Project MCP config requires a real project. Use global scope for general chat.',
    };
  }
  const filePath = scope === 'project' ? getProjectMcpConfigPath(projectPath) : getGlobalMcpConfigPath();
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = normalizeMcpConfig(JSON.parse(raw));
    return {
      exists: true,
      path: filePath,
      raw: JSON.stringify(parsed, null, 2),
      config: parsed,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        path: filePath,
        raw: JSON.stringify(DEFAULT_MCP_CONFIG, null, 2),
        config: DEFAULT_MCP_CONFIG,
      };
    }
    throw error;
  }
}

export async function writeMcpConfigFile(scope, raw, projectPath) {
  const parsed = normalizeMcpConfig(JSON.parse(raw));
  if (scope === 'project' && (!projectPath || isVirtualProjectPath(projectPath, pilotHome()))) {
    throw new Error('Project MCP config requires a real project. Use global scope for general chat.');
  }
  const filePath = scope === 'project' ? getProjectMcpConfigPath(projectPath) : getGlobalMcpConfigPath();
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 });
  return readMcpConfigFile(scope, projectPath);
}

export async function listMcpConfigFiles(projectPath) {
  const [globalConfig, projectConfig] = await Promise.all([
    readMcpConfigFile('global', projectPath),
    readMcpConfigFile('project', projectPath),
  ]);
  return {
    global: globalConfig,
    project: projectConfig,
  };
}

function isStringRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
