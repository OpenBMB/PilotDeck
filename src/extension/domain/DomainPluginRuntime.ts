import type { ArtifactContractStore, ArtifactValidator } from "../../artifact/index.js";
import type { DynamicContextStore } from "../../context/index.js";
import type { PilotDeckLifecycleError } from "../../lifecycle/index.js";
import type { DomainActivation, DomainPlugin, DomainTaskInput } from "./DomainPlugin.js";

export type DomainPluginActivationResult = {
  activations: readonly DomainActivation[];
  errors: readonly PilotDeckLifecycleError[];
};

/** Activates native domain plugins without moving domain knowledge into the agent core. */
export class DomainPluginRuntime {
  constructor(private readonly options: {
    plugins: readonly DomainPlugin[];
    dynamicContext: DynamicContextStore;
    artifactContracts: ArtifactContractStore;
  }) {}

  validators(): readonly ArtifactValidator[] {
    const validators = this.options.plugins.flatMap((plugin) => [...(plugin.validators ?? [])]);
    const ids = new Set<string>();
    for (const validator of validators) {
      if (ids.has(validator.id)) throw new Error(`Duplicate domain artifact validator id: ${validator.id}`);
      ids.add(validator.id);
    }
    return validators;
  }

  async activate(input: DomainTaskInput): Promise<DomainPluginActivationResult> {
    const activations: DomainActivation[] = [];
    const errors: PilotDeckLifecycleError[] = [];
    for (const plugin of this.options.plugins) {
      if (!plugin.detectTask) continue;
      try {
        const activation = await plugin.detectTask(input);
        if (!activation || !Number.isFinite(activation.confidence) || activation.confidence <= 0) continue;
        if (plugin.artifactContracts) {
          const contracts = await plugin.artifactContracts(input);
          this.options.artifactContracts.register(input.sessionId, plugin.id, contracts);
        }
        this.registerActivationContext(plugin, activation, input);
        activations.push(activation);
      } catch (error) {
        errors.push({
          code: "hook_non_blocking_error",
          hookName: plugin.id,
          message: `Domain plugin ${plugin.id} failed to activate: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { activations, errors };
  }

  private registerActivationContext(
    plugin: DomainPlugin,
    activation: DomainActivation,
    input: DomainTaskInput,
  ): void {
    const skillIds = [...new Set([...(plugin.skillIds ?? []), ...(activation.skillIds ?? [])])];
    const content = [
      `Domain plugin "${plugin.id}" activated for this task.`,
      skillIds.length > 0 ? `Load and apply these project-scoped skills: ${skillIds.join(", ")}.` : undefined,
      activation.contextPointer ? `Context pointer: ${activation.contextPointer}` : undefined,
    ].filter((value): value is string => !!value).join("\n");
    this.options.dynamicContext.register({
      sessionId: input.sessionId,
      source: `domain:${plugin.id}`,
      id: activation.domainId,
      content,
      priority: "high",
    });
  }
}
