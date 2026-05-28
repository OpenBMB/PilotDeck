export type PluginContributionLoader = {
  load(): Promise<void>;
};
