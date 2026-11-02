import { existsSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readConfiguration, writeConfiguration, normalizeMcpConfiguration } from '@pilotdeck/config';
import path from 'path';
import { isVirtualProjectPath, resolvePilotHome } from '../utils/pilotPaths.js';

const DEFAULT_MCP_CONFIG = {
  mcpServers: {},
};

function pilotHome() {
  return resolvePilotHome(process.env);
}

export function getGlobalMcpConfigPath() {
  return path.join(pilotHome(), 'mcp.yaml');
}

export function getProjectMcpConfigPath(projectPath) {
  return path.join(projectPath, '.pilotdeck', 'mcp.yaml');
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
      raw: stringifyYaml(DEFAULT_MCP_CONFIG),
      config: DEFAULT_MCP_CONFIG,
      disabled: true,
      reason: 'Project MCP config requires a real project. Use global scope for general chat.',
    };
  }
  const filePath = scope === 'project' ? getProjectMcpConfigPath(projectPath) : getGlobalMcpConfigPath();
  const legacy = filePath.replace(/\.yaml$/, '.json');
  const loaded = readConfiguration(filePath, { defaults: DEFAULT_MCP_CONFIG, create: false, legacyPaths: [legacy], normalize: normalizeMcpConfiguration });
  return { exists: existsSync(filePath), path: filePath, raw: stringifyYaml(loaded.value), config: loaded.value, diagnostics: loaded.diagnostics };
}

export async function writeMcpConfigFile(scope, raw, projectPath) {
  const parsed = normalizeMcpConfig(parseYaml(raw));
  if (scope === 'project' && (!projectPath || isVirtualProjectPath(projectPath, pilotHome()))) {
    throw new Error('Project MCP config requires a real project. Use global scope for general chat.');
  }
  const filePath = scope === 'project' ? getProjectMcpConfigPath(projectPath) : getGlobalMcpConfigPath();
  writeConfiguration(filePath, parsed);
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
