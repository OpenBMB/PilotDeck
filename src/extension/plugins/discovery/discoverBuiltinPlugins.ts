import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";

export function discoverBuiltinPlugins(plugins: PilotDeckLoadedPlugin[] = []): PilotDeckLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source === "builtin");
}
