import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, PilotDeckLoadedPlugin>();

  replaceAll(plugins: PilotDeckLoadedPlugin[]): void {
    this.plugins.clear();
    for (const plugin of plugins) {
      this.plugins.set(`${plugin.name}@${plugin.source}`, plugin);
    }
  }

  list(): PilotDeckLoadedPlugin[] {
    return [...this.plugins.values()];
  }
}
