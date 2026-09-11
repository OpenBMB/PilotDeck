import {
  createSidecarContextRuntime,
  createSidecarPorts,
  type SidecarExecution,
  type SidecarExecutionFactory,
} from "../agent/modules/sidecar.js";
import type {
  HostCapabilityModuleMethod,
  HostContextModuleMethod,
  HostModuleCapabilities,
  HostPermissionModuleMethod,
} from "../agent/modules/protocol.js";
import { AgentLoop } from "../agent/loop/AgentLoop.js";
import { parseAgentLoopSeedStateProjection } from "../agent/modules/checkpoint/seedStateProjection.js";
import type { AgentRuntimeConfig } from "../agent/runtime/AgentRuntimeConfig.js";
import type { AgentRunMode } from "../agent/protocol/input.js";
import { createDefaultPermissionContext } from "../permission/index.js";
import type { PermissionMode, PermissionRuleSet } from "../permission/index.js";
import type { CanonicalContentBlock, CanonicalMessage } from "../model/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolInputSchema } from "../tool/index.js";

/** Host-neutral payload accepted by the default sidecar factory. */
export type SidecarAgentLoopPayload = {
  agent?: Record<string, unknown>;
  task?: Record<string, unknown>;
  messages?: unknown;
  tools?: unknown;
  hostModules?: HostModuleCapabilities;
  /** Host-owned context projection for a single execution. */
  contextOverride?: {
    systemPrompt?: unknown;
    messages?: unknown;
    metadata?: unknown;
    tools?: unknown;
  };
  permissionContext?: unknown;
  seedState?: unknown;
  executionContext?: unknown;
};

/**
 * Default sidecar factory. It maps a generic execute payload to AgentLoop
 * inputs; hosts with different state or module requirements can replace it
 * through `PILOTDECK_AGENT_LOOP_FACTORY`.
 */
export const createSidecarExecution: SidecarExecutionFactory = ({ request, abortSignal, abortExecution, callModule }) => {
  const payload = asRecord(request.payload) ?? {};
  const agent = asRecord(payload.agent) ?? {};
  const task = asRecord(payload.task) ?? {};
  const contextOverride = asRecord(payload.contextOverride) ?? {};
  const executionContext = asRecord(payload.executionContext);
  const hostModules = asRecord(payload.hostModules);
  const contextMethods = readHostContextMethods(asRecord(hostModules?.context)?.methods);
  const capabilityMethods = readHostCapabilityMethods(asRecord(hostModules?.capability)?.methods);
  const permissionMethods = readHostPermissionMethods(asRecord(hostModules?.permission)?.methods);
  const hasOverrideMessages = Object.prototype.hasOwnProperty.call(contextOverride, "messages");
  const sessionId = String(request.sessionId ?? request.operationId);
  const turnId = String(request.turnId ?? request.operationId);
  const cwd = String(agent.cwd ?? payload.cwd ?? process.cwd());
  const permission = asRecord(payload.permissionContext) ?? {};
  const permissionMode = isPermissionMode(permission.mode)
    ? permission.mode
    : isPermissionMode(agent.permissionMode)
      ? agent.permissionMode
      : "default";
  const canPrompt = permission.canPrompt === true;
  const bypassAvailable = permission.bypassAvailable === true;
  const runMode = asRunMode(agent.runMode ?? payload.runMode);
  const config: AgentRuntimeConfig = {
    provider: String(agent.provider ?? payload.provider ?? "default"),
    model: String(agent.model ?? payload.model ?? "default"),
    ...(asManagedModelPolicy(agent.managedModelPolicy) ? {
      managedModelPolicy: asManagedModelPolicy(agent.managedModelPolicy),
    } : {}),
    cwd,
    systemPrompt: asString(
      contextOverride.systemPrompt ?? agent.systemPrompt ?? payload.systemPrompt,
    ),
    maxOutputTokens: asPositiveInteger(agent.maxOutputTokens ?? payload.maxOutputTokens),
    maxContextTokens: asPositiveInteger(agent.maxContextTokens ?? payload.maxContextTokens),
    runMode,
    permissionMode,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: permissionMode,
      canPrompt,
      bypassAvailable,
      rules: asPermissionRules(permission.rules),
    }),
    metadata: mergeMetadata(executionContext, asRecord(contextOverride.metadata)),
  };
  const tools = readToolDescriptors(
    contextOverride.tools !== undefined ? contextOverride.tools : payload.tools,
  ).map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    kind: descriptor.kind,
    inputSchema: descriptor.inputSchema,
    isReadOnly: () => descriptor.readOnly,
    isConcurrencySafe: () => descriptor.concurrencySafe,
    requiresUserInteraction: () => descriptor.requiresUserInteraction,
    execute: async () => ({ content: [{ type: "text", text: "Capability is executed by the host module." }] }),
  } satisfies PilotDeckToolDefinition));
  const context = contextMethods.includes("prepare_for_model")
    ? createSidecarContextRuntime(callModule, {
        runId: request.runId,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
      }, contextMethods)
    : undefined;
  const loop = new AgentLoop(
    config,
    {
      router: {} as never,
      ports: createSidecarPorts(callModule, {
        tools,
        capabilityMethods,
        permissionMethods,
        onAbort: abortExecution,
      }),
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      ...(context ? { context } : {}),
    },
    parseAgentLoopSeedStateProjection(payload.seedState),
  );
  return {
    loop,
    input: {
      sessionId,
      turnId,
      messages: buildInitialMessages(
        task,
        hasOverrideMessages ? contextOverride.messages : payload.messages,
        hasOverrideMessages,
      ),
      maxTurns: asPositiveInteger(agent.maxTurns ?? payload.maxTurns),
      runMode,
      abortSignal,
      permissionMode,
      canPrompt,
      permissionRules: asPermissionRules(permission.rules),
      modelOverride: asModelOverride(agent.modelOverride ?? payload.modelOverride),
      execution: {
        runId: request.runId,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        operationDeadline: request.operationDeadline,
      },
    },
  } as SidecarExecution;
};

type ToolDescriptor = {
  name: string;
  description: string;
  kind: PilotDeckToolDefinition["kind"];
  inputSchema: PilotDeckToolInputSchema;
  readOnly: boolean;
  concurrencySafe: boolean;
  requiresUserInteraction: boolean;
};

function buildInitialMessages(
  task: Record<string, unknown>,
  rawMessages: unknown,
  explicitOverride = false,
): CanonicalMessage[] {
  const messages = Array.isArray(rawMessages) ? rawMessages.flatMap(toCanonicalMessages) : [];
  if (explicitOverride) return messages;
  const taskPrompt = asString(task.prompt ?? task.instruction ?? task.description);
  if (messages.length > 0) return messages;
  if (taskPrompt) return [{ role: "user", content: [{ type: "text", text: taskPrompt }] }];
  return [{ role: "user", content: [{ type: "text", text: JSON.stringify(task) }] }];
}

function toCanonicalMessages(rawMessage: unknown): CanonicalMessage[] {
  const message = asRecord(rawMessage);
  if (!message) return [];
  const role = message.role === "assistant" ? "assistant" : "user";
  const content: CanonicalContentBlock[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  if (Array.isArray(message.content)) content.push(...message.content.flatMap(toCanonicalContentBlocks));
  if (Array.isArray(message.images)) content.push(...message.images.flatMap(toCanonicalContentBlocks));
  return content.length > 0 ? [{ role, content }] : [];
}

function toCanonicalContentBlocks(value: unknown): CanonicalContentBlock[] {
  const block = asRecord(value);
  if (!block) return [];
  if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
  if (block.type === "tool_call" && typeof block.id === "string" && typeof block.name === "string") {
    return [{ type: "tool_call", id: block.id, name: block.name, input: block.input ?? {} }];
  }
  if (block.type === "tool_result" && typeof block.toolCallId === "string") {
    const content: CanonicalContentBlock[] = Array.isArray(block.content)
      ? block.content.flatMap(toCanonicalContentBlocks)
      : typeof block.content === "string"
        ? [{ type: "text", text: block.content }]
        : [];
    return [{
      type: "tool_result",
      toolCallId: block.toolCallId,
      content: content as any,
      ...(block.isError === true ? { isError: true } : {}),
      ...(block.raw !== undefined ? { raw: block.raw } : {}),
    }];
  }
  if (block.type === "image" && block.source === "base64" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return [{
      type: "image",
      source: "base64",
      mimeType: block.mimeType,
      data: block.data,
      ...(block.detail === "auto" || block.detail === "low" || block.detail === "high"
        ? { detail: block.detail }
        : {}),
    }];
  }
  if (block.type === "image_url") {
    const url = asRecord(block.image_url)?.url;
    if (typeof url === "string") {
      const match = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (match) return [{ type: "image", source: "base64", mimeType: match[1]!, data: match[2]! }];
    }
  }
  return [];
}

function mergeMetadata(
  executionContext: Record<string, unknown> | undefined,
  overrideMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!executionContext && !overrideMetadata) return undefined;
  return { ...(executionContext ?? {}), ...(overrideMetadata ?? {}) };
}

function readToolDescriptors(value: unknown): ToolDescriptor[] {
  const record = asRecord(value);
  const items = Array.isArray(value) ? value : Array.isArray(record?.available) ? record.available : [];
  return items.flatMap((item) => {
    const descriptor = asRecord(item);
    const name = asString(descriptor?.name);
    if (!descriptor || !name) return [];
    return [{
      name,
      description: asString(descriptor.description) ?? "Host capability",
      kind: isToolKind(descriptor.kind) ? descriptor.kind : "custom",
      inputSchema: asInputSchema(descriptor.inputSchema ?? descriptor.input_schema),
      readOnly: descriptor.readOnly === true,
      concurrencySafe: descriptor.concurrencySafe === true,
      requiresUserInteraction: descriptor.requiresUserInteraction === true,
    }];
  });
}

function readHostContextMethods(value: unknown): HostContextModuleMethod[] {
  if (!Array.isArray(value)) return [];
  return value.filter((method): method is HostContextModuleMethod =>
    method === "prepare_for_model"
    || method === "apply_tool_results"
    || method === "recover_from_model_error"
    || method === "capture_turn");
}

function readHostCapabilityMethods(value: unknown): HostCapabilityModuleMethod[] {
  if (!Array.isArray(value)) return [];
  return value.filter((method): method is HostCapabilityModuleMethod =>
    method === "execute" || method === "execute_batch");
}

function readHostPermissionMethods(value: unknown): HostPermissionModuleMethod[] {
  if (!Array.isArray(value)) return [];
  return value.filter((method): method is HostPermissionModuleMethod => method === "decide");
}


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRunMode(value: unknown): AgentRunMode | undefined {
  return value === "agent" || value === "plan" || value === "ask" ? value : undefined;
}

function asModelOverride(value: unknown): { provider: string; model: string } | undefined {
  const override = asRecord(value);
  const provider = asString(override?.provider);
  const model = asString(override?.model);
  return provider && model ? { provider, model } : undefined;
}

function asManagedModelPolicy(value: unknown): { allow: string[]; deny: string[] } | undefined {
  const policy = asRecord(value);
  if (!policy) return undefined;
  const allow = Array.isArray(policy.allow) && policy.allow.every((entry) => typeof entry === "string")
    ? [...policy.allow]
    : undefined;
  const deny = Array.isArray(policy.deny) && policy.deny.every((entry) => typeof entry === "string")
    ? [...policy.deny]
    : undefined;
  return allow && deny ? { allow, deny } : undefined;
}

function asInputSchema(value: unknown): PilotDeckToolInputSchema {
  const schema = asRecord(value);
  return schema?.type === "object" ? schema as PilotDeckToolInputSchema : { type: "object" };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "plan" || value === "bypassPermissions";
}

function asPermissionRules(value: unknown): Partial<PermissionRuleSet> | undefined {
  const rules = asRecord(value);
  if (!rules) return undefined;
  return {
    allow: Array.isArray(rules.allow) ? rules.allow as PermissionRuleSet["allow"] : undefined,
    deny: Array.isArray(rules.deny) ? rules.deny as PermissionRuleSet["deny"] : undefined,
    ask: Array.isArray(rules.ask) ? rules.ask as PermissionRuleSet["ask"] : undefined,
  };
}

function isToolKind(value: unknown): value is PilotDeckToolDefinition["kind"] {
  return value === "filesystem" || value === "shell" || value === "network" || value === "mcp"
    || value === "session" || value === "agent" || value === "structured_output" || value === "custom";
}


export default createSidecarExecution;
