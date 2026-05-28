import { resolve } from "node:path";

export function validatePluginSourcePath(pluginPath: string, allowedRoot: string): boolean {
  const resolvedPlugin = resolve(pluginPath);
  const resolvedRoot = resolve(allowedRoot);
  return resolvedPlugin === resolvedRoot || resolvedPlugin.startsWith(`${resolvedRoot}/`);
}
