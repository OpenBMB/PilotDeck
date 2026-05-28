import type { CanonicalToolSchema } from "../../model/index.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export class ToolRegistry {
  private readonly toolsByName = new Map<string, PilotDeckToolDefinition>();
  private readonly aliases = new Map<string, string>();

  register(tool: PilotDeckToolDefinition): void {
    if (this.toolsByName.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }

    if (this.aliases.has(tool.name)) {
      throw new Error(`Tool ${tool.name} conflicts with an existing alias.`);
    }

    for (const alias of tool.aliases ?? []) {
      if (this.toolsByName.has(alias)) {
        throw new Error(`Alias ${alias} conflicts with an existing tool name.`);
      }
      if (this.aliases.has(alias)) {
        throw new Error(`Alias ${alias} is already registered.`);
      }
    }

    this.toolsByName.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
  }

  get(name: string): PilotDeckToolDefinition | undefined {
    const realName = this.aliases.get(name) ?? name;
    return this.toolsByName.get(realName);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): PilotDeckToolDefinition[] {
    return [...this.toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  toCanonicalSchemas(): CanonicalToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Shallow-clone this registry so the caller can register additional tools
   * (or replace existing ones) without mutating the original.  Tool
   * definitions are shared by reference — only the lookup maps are copied.
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const [name, tool] of this.toolsByName) {
      copy.toolsByName.set(name, tool);
    }
    for (const [alias, realName] of this.aliases) {
      copy.aliases.set(alias, realName);
    }
    return copy;
  }

  /**
   * Remove a tool (and its aliases) from the registry.
   * Returns true if the tool was found and removed, false otherwise.
   */
  unregister(name: string): boolean {
    const tool = this.toolsByName.get(name);
    if (!tool) return false;
    for (const alias of tool.aliases ?? []) {
      this.aliases.delete(alias);
    }
    this.toolsByName.delete(name);
    return true;
  }

  /**
   * Replace an existing tool definition in-place.  Unlike `register()`,
   * this overwrites the entry keyed by `tool.name` (which must already
   * exist).  Aliases from the *previous* definition are removed and
   * replaced with those from the new one.
   */
  replace(tool: PilotDeckToolDefinition): void {
    const existing = this.toolsByName.get(tool.name);
    if (!existing) {
      throw new Error(`Tool ${tool.name} is not registered — cannot replace.`);
    }
    for (const alias of existing.aliases ?? []) {
      this.aliases.delete(alias);
    }
    this.toolsByName.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
  }
}
