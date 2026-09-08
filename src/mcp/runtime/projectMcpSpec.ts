import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PilotDeckMcpServerSpec } from "../protocol/types.js";

export const PILOTDECK_PROJECT_ROOT_MARKER = "__PILOTDECK_PROJECT_ROOT__";
export const PILOTDECK_NODE_EXECUTABLE_MARKER = "__PILOTDECK_NODE_EXECUTABLE__";
export const PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER = "__PILOTDECK_FUNASR_MCP_ENTRYPOINT__";
export const PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER = "__PILOTDECK_FUNASR_RUNTIME_ROOT__";
export const PILOTDECK_FUNASR_INSTALL_COMMAND_MARKER = "__PILOTDECK_FUNASR_INSTALL_COMMAND__";
export const PILOTDECK_PLAYWRIGHT_MCP_ENTRYPOINT_MARKER = "__PILOTDECK_PLAYWRIGHT_MCP_ENTRYPOINT__";

const MODULE_DIR = (() => {
  try { return resolve(fileURLToPath(import.meta.url), ".."); } catch { return resolve(process.cwd()); }
})();

function findPackageRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "scripts", "install-asr.mjs"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function getPilotDeckInstallCommand(): string {
  return `npm --prefix "${findPackageRoot(MODULE_DIR)}" run install:asr`;
}

function funasrEntrypoint(): string {
  // This relative path is identical in source and in dist, where built-in
  // plugin files are copied next to the compiled extension modules.
  return resolve(MODULE_DIR, "../../extension/plugins/builtin/funasr/funasr-local-mcp.mjs");
}

function playwrightMcpEntrypoint(): string {
  const candidates = [
    process.env.PILOTDECK_RUNTIME_ROOT
      ? resolve(process.env.PILOTDECK_RUNTIME_ROOT, "node_modules", "@playwright", "mcp", "cli.js")
      : "",
    resolve(MODULE_DIR, "../../../node_modules/@playwright/mcp/cli.js"),
    resolve(MODULE_DIR, "../../../../node_modules/@playwright/mcp/cli.js"),
    resolve(process.cwd(), "node_modules/@playwright/mcp/cli.js"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** Resolve placeholders used only by the built-in project-scoped FunASR MCP. */
export function patchProjectScopedMcpSpec(
  spec: PilotDeckMcpServerSpec,
  projectRoot: string,
  pilotHome: string,
): PilotDeckMcpServerSpec {
  if (spec.transport !== "stdio") return spec;

  if (spec.id === "browser-use") {
    const replaceBrowserMarkers = (value: string) => value
      .replaceAll(PILOTDECK_NODE_EXECUTABLE_MARKER, process.execPath)
      .replaceAll(PILOTDECK_PLAYWRIGHT_MCP_ENTRYPOINT_MARKER, playwrightMcpEntrypoint());
    return {
      ...spec,
      command: replaceBrowserMarkers(spec.command),
      cwd: resolve(projectRoot),
      args: spec.args?.map(replaceBrowserMarkers),
    };
  }

  if (spec.id !== "funasr") return spec;

  const replacements: Record<string, string> = {
    [PILOTDECK_PROJECT_ROOT_MARKER]: resolve(projectRoot),
    [PILOTDECK_NODE_EXECUTABLE_MARKER]: process.execPath,
    [PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER]: funasrEntrypoint(),
    [PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER]: join(resolve(pilotHome), "funasr"),
    [PILOTDECK_FUNASR_INSTALL_COMMAND_MARKER]: getPilotDeckInstallCommand(),
  };
  const replaceMarkers = (value: string) => Object.entries(replacements)
    .reduce((out, [marker, replacement]) => out.replaceAll(marker, replacement), value);

  return {
    ...spec,
    command: replaceMarkers(spec.command),
    cwd: resolve(projectRoot),
    args: spec.args?.map(replaceMarkers),
  };
}
