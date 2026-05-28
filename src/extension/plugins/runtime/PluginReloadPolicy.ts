export type PluginReloadPolicy = {
  pruneRemovedImmediately: boolean;
  activateNewPlugins: "nextReload" | "nextTurn" | "immediate";
  keepOldHooksUntilSwap: boolean;
};

export const defaultPluginReloadPolicy: PluginReloadPolicy = {
  pruneRemovedImmediately: true,
  activateNewPlugins: "nextReload",
  keepOldHooksUntilSwap: true,
};
