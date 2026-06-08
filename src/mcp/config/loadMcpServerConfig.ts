import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const MCP_CONFIG_FILE_NAME = "mcp.json";

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

  return {
    servers: {
      ...(global?.mcpServers ?? {}),
      ...(project?.mcpServers ?? {}),
    },
    diagnostics,
  };
}

function readMcpConfig(
  path: string,
  diagnostics: LoadMcpServerConfigResult["diagnostics"],
): { mcpServers?: Record<string, unknown> } | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
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

  return { mcpServers: expandConfig(rawServers) as Record<string, unknown> };
}

function expandConfig(value: unknown): unknown {
  if (typeof value === "string") {
    return expandString(value);
  }
  if (Array.isArray(value)) {
    return value.map(expandConfig);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandConfig(entry)]));
  }
  return value;
}

function expandString(value: string): string {
  return value
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/\$\{userHome\}/g, process.env.HOME ?? process.env.USERPROFILE ?? homedir());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
