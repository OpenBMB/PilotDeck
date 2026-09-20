import type { PilotDeckToolInputSchema, PilotDeckToolKind } from "../tool/index.js";

export const MODULE_HTTP_TRANSPORT = "module-http-v2" as const;

export const MODULE_SLOT_CONTRACTS = {
  agentLoop: "pilotdeck.agent-loop/v1",
  skills: "pilotdeck.skills/v1",
  tools: "pilotdeck.tools/v1",
  context: "pilotdeck.context/v1",
  modelProvider: "pilotdeck.model/v1",
  knowledge: "staffdeck.knowledge/v1",
} as const;

export type ComposableModuleSlot = keyof typeof MODULE_SLOT_CONTRACTS;

/** Deployment source metadata consumed by the generic exporter only. */
export type ModuleDeployment = Readonly<{
  mode: "build" | "image" | "external";
  context?: string;
  dockerfile?: string;
  image?: string;
  port?: number;
  healthPath?: string;
}>;

export type NativeModuleBinding = Readonly<{
  enabled: true;
  provider: "pilotdeck";
}>;

export type DisabledModuleBinding = Readonly<{
  enabled: false;
}>;

export type ExternalToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: PilotDeckToolInputSchema;
  kind?: PilotDeckToolKind;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  requiresUserInteraction?: boolean;
}>;

export type ExternalModuleBinding = Readonly<{
  enabled: true;
  implementationId: string;
  contract: string;
  transport: typeof MODULE_HTTP_TRANSPORT;
  endpoint: string;
  manifestPath: string;
  callPath: string;
  timeoutMs?: number;
  methods: readonly string[];
  tools?: readonly ExternalToolDescriptor[];
  deployment?: ModuleDeployment;
}>;

export type ExternalAgentLoopBinding = Readonly<{
  enabled: true;
  implementationId: string;
  contract: typeof MODULE_SLOT_CONTRACTS.agentLoop;
  transport: "module-stdio-v2" | "module-tcp-v2";
  methods: readonly string[];
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  host?: string;
  port?: number;
  connectTimeoutMs?: number;
  deployment?: ModuleDeployment;
}>;

export type CoreModuleBinding = NativeModuleBinding | DisabledModuleBinding | ExternalModuleBinding | ExternalAgentLoopBinding;

export function isDisabledModuleBinding(binding: CoreModuleBinding | undefined): binding is DisabledModuleBinding {
  return binding?.enabled === false;
}

export function isExternalModuleBinding(binding: CoreModuleBinding | undefined): binding is ExternalModuleBinding {
  return binding !== undefined && "implementationId" in binding && binding.transport === MODULE_HTTP_TRANSPORT;
}

export function isExternalAgentLoopBinding(binding: CoreModuleBinding | undefined): binding is ExternalAgentLoopBinding {
  return binding !== undefined && "implementationId" in binding
    && (binding.transport === "module-stdio-v2" || binding.transport === "module-tcp-v2");
}
