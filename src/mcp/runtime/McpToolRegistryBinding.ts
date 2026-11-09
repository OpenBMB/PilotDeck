import type { ToolRegistry, PilotDeckToolDefinition } from "../../tool/index.js";
import type { McpRuntime } from "./McpRuntime.js";
import { createMcpToolDefinitionsFromRuntime, getMcpToolOwner } from "./PluginToToolBridge.js";

/** Publishes complete MCP contracts only at the owning session's request boundary. */
export class McpToolRegistryBinding {
  private owned: Map<string, PilotDeckToolDefinition>;
  private disposed = false;

  constructor(private readonly registry: ToolRegistry, private readonly runtimes: readonly McpRuntime[],
    private readonly include: (tool: PilotDeckToolDefinition) => boolean = () => true,
    private readonly isActive: () => boolean = () => true) {
    this.owned = new Map(registry.list().filter(tool => runtimes.includes(getMcpToolOwner(tool)!)).map(tool => [tool.name, tool]));
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.disposed || !this.isActive()) return;
    const groups = await Promise.all(this.runtimes.map(runtime => createMcpToolDefinitionsFromRuntime(runtime, { refresh: true, signal })));
    signal?.throwIfAborted();
    if (this.disposed || !this.isActive()) return;
    for (const [name, tool] of this.owned) {
      if (this.registry.get(name) !== tool) throw new Error(`MCP tool ownership changed for ${name}; the catalog was not replaced.`);
    }
    const tools = groups.flat().filter(this.include);
    this.registry.replaceGroup([...this.owned.keys()], tools);
    this.owned = new Map(tools.map(tool => [tool.name, tool]));
  }

  dispose(): void { this.disposed = true; }
}

/** One session lease can supply independently scoped parent and child registries. */
export function createMcpToolCatalogRefresher(runtimes: readonly McpRuntime[], include: (tool: PilotDeckToolDefinition) => boolean = () => true) {
  const bindings = new WeakMap<ToolRegistry, McpToolRegistryBinding>();
  let active = true;
  return {
    async refresh(registry: ToolRegistry, signal?: AbortSignal, scope: (tool: PilotDeckToolDefinition) => boolean = () => true) {
      if (!active) return;
      let binding = bindings.get(registry);
      if (!binding) {
        binding = new McpToolRegistryBinding(registry, runtimes, tool => include(tool) && scope(tool), () => active);
        bindings.set(registry, binding);
      }
      await binding.refresh(signal);
    },
    dispose() { active = false; },
  };
}
