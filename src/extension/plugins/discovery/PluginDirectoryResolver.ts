import type { PilotExtensionPaths } from "../../../pilot/paths.js";
import { getPilotExtensionPaths } from "../../../pilot/paths.js";

export type PluginDirectoryResolverInput = {
  projectRoot: string;
  pilotHome: string;
};

export function resolvePluginDirectories(input: PluginDirectoryResolverInput): PilotExtensionPaths {
  return getPilotExtensionPaths(input.projectRoot, input.pilotHome);
}
