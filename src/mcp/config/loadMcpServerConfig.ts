import { existsSync } from "node:fs";
import { readConfiguration, normalizeMcpConfiguration } from '@pilotdeck/config';
import { resolve } from "node:path";

import { expandMcpConfig } from "./expandPlaceholders.js";

export const MCP_CONFIG_FILE_NAME = "mcp.yaml";

export type LoadMcpServerConfigResult = {
  servers: Record<string, unknown>;
  diagnostics: { path: string; message: string }[];
};

export function getGlobalMcpConfigFilePath(pilotHome: string): string {
  return resolve(pilotHome, MCP_CONFIG_FILE_NAME);
}

export function getProjectMcpConfigFilePath(projectRoot: string): string {
  return resolve(projectRoot, ".pilotdeck", MCP_CONFIG_FILE_NAME);
}

export function loadMcpServerConfig(projectRoot: string, pilotHome: string): LoadMcpServerConfigResult {
  const diagnostics: LoadMcpServerConfigResult["diagnostics"] = [];
  const global = readMcpConfig(getGlobalMcpConfigFilePath(pilotHome), diagnostics);
  const project = readMcpConfig(getProjectMcpConfigFilePath(projectRoot), diagnostics);
  const managedPath = process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
  const managed = managedPath ? readMcpConfig(managedPath, diagnostics) : undefined;
  const servers = { ...(global?.mcpServers ?? {}), ...(project?.mcpServers ?? {}) };
  if (managedPath) {
    delete servers['pilotdeck-computer-use'];
    const driver = managed?.mcpServers?.['pilotdeck-computer-use'];
    if (isRecord(driver)) servers['pilotdeck-computer-use'] = driver;
  }

  return {
    // Only the desktop host controls this reserved server's executable and enable switch.
    servers,
    diagnostics,
  };
}

function readMcpConfig(
  path: string,
  diagnostics: LoadMcpServerConfigResult["diagnostics"],
): { mcpServers?: Record<string, unknown> } | undefined {
  const legacy = path.replace(/\.yaml$/, '.json');
  if (!existsSync(path) && !existsSync(legacy)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = readConfiguration(path, { defaults: { mcpServers: {} }, legacyPaths: legacy !== path ? [legacy] : [], repair: path.endsWith('.yaml'), create: false,
      normalize: normalizeMcpConfiguration,
      onDiagnostic: issue => diagnostics.push({ path: issue.field || issue.path, message: `[${issue.code}] ${issue.message}` }),
    }).value;
  } catch (error) {
    diagnostics.push({
      path,
      message: error instanceof Error ? error.message : "Invalid JSON",
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    diagnostics.push({ path, message: "MCP config root must be an object." });
    return undefined;
  }

  const rawServers = parsed.mcpServers;
  if (rawServers === undefined) {
    return {};
  }
  if (!isRecord(rawServers)) {
    diagnostics.push({ path, message: "mcpServers must be an object." });
    return {};
  }

  return { mcpServers: expandMcpConfig(rawServers) as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
