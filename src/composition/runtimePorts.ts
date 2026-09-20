import {
  createHostCapabilityToolPort,
  createHostContextRuntime,
  createHostModelInvokerPort,
  type HostCapabilityModuleMethod,
  type HostContextModuleMethod,
  type HostModelModuleMethod,
  type ModelInvokerPort,
  type ToolPort,
} from "../agent/modules/index.js";
import type { AgentContextRuntime } from "../context/index.js";
import type { PilotDeckToolDefinition } from "../tool/index.js";
import { HttpModuleClient } from "./HttpModuleClient.js";
import { isExternalModuleBinding, type CoreModuleBinding, type ExternalModuleBinding } from "./types.js";

export type RuntimeModuleBindings = Readonly<{
  modelProvider?: CoreModuleBinding;
  tools?: CoreModuleBinding;
  context?: CoreModuleBinding;
}>;

export type ResolvedRuntimeModulePorts = Readonly<{
  model?: ModelInvokerPort;
  tools?: ToolPort;
  context?: AgentContextRuntime;
}>;

/**
 * Keep host-owned session tools visible when an external capability module is
 * selected. Calls are routed by the frozen public tool name; neither owner is
 * reimplemented or allowed to execute the other owner's calls.
 */
export function composeToolPorts(primary: ToolPort, fallback: ToolPort): ToolPort {
  const primaryTools = primary.list();
  const fallbackTools = fallback.list();
  const primaryNames = new Set(primaryTools.map((tool) => tool.name));
  const duplicate = fallbackTools.find((tool) => primaryNames.has(tool.name));
  if (duplicate) throw new Error(`External tool binding conflicts with host tool '${duplicate.name}'.`);
  const primaryNamesSnapshot = primaryNames;
  const descriptors = new Map([...primaryTools, ...fallbackTools].map((tool) => [tool.name, tool]));
  return {
    list: () => [...primaryTools, ...fallbackTools],
    async executeAll(calls, context, execution) {
      const resultSlots = new Array<Awaited<ReturnType<ToolPort["executeAll"]>>[number]>(calls.length);
      const safeGroups = new Map<ToolPort, Array<{ index: number; call: (typeof calls)[number] }>>();
      const sequential: Array<{ index: number; call: (typeof calls)[number]; port: ToolPort }> = [];
      for (const [index, call] of calls.entries()) {
        const port = primaryNamesSnapshot.has(call.name) ? primary : fallback;
        const descriptor = descriptors.get(call.name);
        if (!descriptor?.isConcurrencySafe(call.input)) {
          sequential.push({ index, call, port });
          continue;
        }
        const entries = safeGroups.get(port) ?? [];
        entries.push({ index, call });
        safeGroups.set(port, entries);
      }

      // Mirror ConcurrentToolScheduler: safe calls may overlap, but every
      // non-safe call is globally ordered, even when a different owner owns it.
      await Promise.all([...safeGroups.entries()].map(async ([port, entries]) => {
        const results = await port.executeAll.call(
          port,
          entries.map((entry) => entry.call),
          context,
          execution,
        );
        if (results.length !== entries.length) throw new Error("Composed tool port returned an incomplete result set.");
        for (const [resultIndex, entry] of entries.entries()) resultSlots[entry.index] = results[resultIndex]!;
      }));
      for (const entry of sequential) {
        const results = await entry.port.executeAll.call(entry.port, [entry.call], context, execution);
        if (results.length !== 1) throw new Error("Composed tool port returned an incomplete result set.");
        resultSlots[entry.index] = results[0]!;
      }
      return resultSlots;
    },
  };
}

export function createRuntimeModulePorts(
  bindings: RuntimeModuleBindings | undefined,
  sessionId: string,
): ResolvedRuntimeModulePorts {
  if (!bindings) return {};
  const modelBinding = external(bindings.modelProvider);
  const toolBinding = external(bindings.tools);
  const contextBinding = external(bindings.context);
  const model = modelBinding ? createExternalModelPort(modelBinding) : undefined;
  const tools = toolBinding ? createExternalToolPort(toolBinding) : undefined;
  const context = contextBinding ? createExternalContextPort(contextBinding, sessionId) : undefined;
  return Object.freeze({
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
    ...(context ? { context } : {}),
  });
}

function createExternalModelPort(binding: ExternalModuleBinding): ModelInvokerPort {
  const client = new HttpModuleClient(binding);
  return createHostModelInvokerPort(client.call, {
    methods: binding.methods as readonly HostModelModuleMethod[],
  });
}

function createExternalToolPort(binding: ExternalModuleBinding): ToolPort {
  const client = new HttpModuleClient(binding);
  const tools = (binding.tools ?? []).map(toToolDefinition);
  return createHostCapabilityToolPort(client.call, {
    methods: binding.methods as readonly HostCapabilityModuleMethod[],
    tools,
  });
}

function createExternalContextPort(binding: ExternalModuleBinding, sessionId: string): AgentContextRuntime {
  const client = new HttpModuleClient(binding);
  return createHostContextRuntime(
    client.call,
    { runId: sessionId, operationId: `context-${sessionId}` },
    binding.methods as readonly HostContextModuleMethod[],
  );
}

function toToolDefinition(descriptor: NonNullable<ExternalModuleBinding["tools"]>[number]): PilotDeckToolDefinition {
  return {
    name: descriptor.name,
    description: descriptor.description,
    kind: descriptor.kind ?? "custom",
    inputSchema: descriptor.inputSchema,
    isReadOnly: () => descriptor.readOnly === true,
    isConcurrencySafe: () => descriptor.concurrencySafe === true,
    ...(descriptor.requiresUserInteraction === undefined
      ? {}
      : { requiresUserInteraction: () => descriptor.requiresUserInteraction === true }),
    execute: async () => {
      throw new Error("External tool definitions execute through the configured ToolPort.");
    },
  };
}

function external(binding: CoreModuleBinding | undefined): ExternalModuleBinding | undefined {
  return isExternalModuleBinding(binding) ? binding : undefined;
}
