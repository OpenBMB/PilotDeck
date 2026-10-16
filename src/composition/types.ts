import type { PilotDeckToolInputSchema, PilotDeckToolKind } from "../tool/index.js";

export const MODULE_HTTP_TRANSPORT = "module-http-v2" as const;

import { MODULE_SLOT_CONTRACTS } from "./contracts.js";
export { MODULE_SLOT_CONTRACTS } from "./contracts.js";

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
  transport: typeof MODULE_HTTP_TRANSPORT | "rest-http-v1";
  endpoint: string;
  manifestPath: string;
  callPath: string;
  /** Server-only environment variable holding the SD account public credential. */
  credentialEnv?: string;
  spaceId?: string;
  spaces?: readonly Readonly<{ id: string; name?: string }>[];
  pilotDeckUserId?: string;
  readOnly?: boolean;
  namespace?: string;
  capabilitiesCredentialEnv?: string;
  localRuntime?: import('./localKnowledgeRuntime.mjs').LocalKnowledgeRuntimeConfig;
  timeoutMs?: number;
  methods: readonly string[];
  agentMethods?: readonly string[];
  /** Optional static frontend registry key selected by the profile. */
  frontendModule?: string;
  /** Module-owned tenant scope used by integrations that require it. */
  tenantId?: string;
  /** Module-owned actor identity used by integrations that require it. */
  actorUserId?: string;
  /** Module-owned agent scope used by integrations that require branch visibility. */
  agentId?: string;
  tools?: readonly ExternalToolDescriptor[];
  deployment?: ModuleDeployment;
}>;

export type ExternalAgentLoopBinding = Readonly<{
  enabled: true;
  implementationId: string;
  contract: typeof MODULE_SLOT_CONTRACTS.agentLoop;
  transport: "module-stdio-v2" | "module-tcp-v2";
  methods: readonly string[];
  frontendModule?: string;
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
  return binding !== undefined && "implementationId" in binding
    && (binding.transport === MODULE_HTTP_TRANSPORT || binding.transport === "rest-http-v1");
}

export function isExternalAgentLoopBinding(binding: CoreModuleBinding | undefined): binding is ExternalAgentLoopBinding {
  return binding !== undefined && "implementationId" in binding
    && (binding.transport === "module-stdio-v2" || binding.transport === "module-tcp-v2");
}
