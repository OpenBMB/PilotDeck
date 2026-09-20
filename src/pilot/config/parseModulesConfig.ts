import { isAbsolute, join, resolve } from "node:path";

import { isRecord } from "../../model/config/schema.js";
import {
  STAFFDECK_SOP_CONTRACT,
  STAFFDECK_SOP_TRANSPORT,
  type SopRuntimeConfig,
} from "../../sop/staffdeck/types.js";
import type { PilotConfigDiagnostic, PilotModulesConfig } from "./types.js";
import {
  MODULE_HTTP_TRANSPORT,
  MODULE_SLOT_CONTRACTS,
  supportedContract,
  supportedMethods,
  validateExternalContract,
  type ComposableModuleSlot,
  type CoreModuleBinding,
  type ExternalAgentLoopBinding,
  type ExternalToolDescriptor,
  type ModuleDeployment,
} from "../../composition/index.js";

const CORE_MODULE_NAMES = ["agentLoop", "skills", "modelProvider", "tools", "context", "knowledge"] as const;

/** Parse the first supported composition profile without silently changing ownership. */
export function parseModulesConfig(
  raw: unknown,
  pilotHome: string,
  diagnostics: PilotConfigDiagnostic[],
): PilotModulesConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    fatal(diagnostics, "MODULES_INVALID", "modules must be an object.", "modules");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (![...CORE_MODULE_NAMES, "sop"].includes(key as (typeof CORE_MODULE_NAMES)[number] | "sop")) {
      warning(diagnostics, "MODULES_UNKNOWN_FIELD", `Unknown modules field '${key}'.`, `modules.${key}`);
    }
  }

  const core = Object.fromEntries(CORE_MODULE_NAMES.map((name) => [name, parseCoreModule(name, raw[name], diagnostics)]));
  if (
    isExternalBinding(core.agentLoop)
    && CORE_MODULE_NAMES.some((name) => name !== "agentLoop" && isExternalBinding(core[name]))
  ) {
    for (const name of CORE_MODULE_NAMES) {
      if (core[name]) continue;
      fatal(
        diagnostics,
        "MODULE_CORE_BINDING_REQUIRED",
        `modules.${name} must be explicitly bound when any external core module is selected.`,
        `modules.${name}`,
      );
    }
  }
  const sop = parseSopModule(raw.sop, pilotHome, diagnostics);
  return {
    ...(core.agentLoop ? { agentLoop: core.agentLoop } : {}),
    ...(core.skills ? { skills: core.skills } : {}),
    ...(core.modelProvider ? { modelProvider: core.modelProvider } : {}),
    ...(core.tools ? { tools: core.tools } : {}),
    ...(core.context ? { context: core.context } : {}),
    ...(sop ? { sop } : {}),
    ...(core.knowledge ? { knowledge: core.knowledge } : {}),
  };
}

function isExternalBinding(value: CoreModuleBinding | undefined): boolean {
  return value !== undefined && "implementationId" in value;
}

function parseCoreModule(
  name: (typeof CORE_MODULE_NAMES)[number],
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): CoreModuleBinding | undefined {
  if (value === undefined || value === null) return undefined;
  const path = `modules.${name}`;
  if (!isRecord(value)) {
    fatal(diagnostics, "MODULE_INVALID", `${path} must be an object.`, path);
    return undefined;
  }
  if (value.stateMode !== undefined) {
    fatal(
      diagnostics,
      "MODULE_STATE_MODE_UNSUPPORTED",
      `${path}.stateMode is not part of the published module contract and cannot be accepted implicitly.`,
      `${path}.stateMode`,
    );
  }
  warnUnknownKeys(value, [
    "enabled", "provider", "implementationId", "contract", "transport", "endpoint",
    "manifestPath", "callPath", "timeoutMs", "methods", "catalog",
    "command", "args", "env", "host", "port", "connectTimeoutMs", "deployment",
  ], path, diagnostics);
  if (value.enabled === false && (name === "skills" || name === "knowledge")) {
    return { enabled: false };
  }
  if (value.enabled !== true) {
    fatal(diagnostics, "MODULE_ENABLED_INVALID", `${path}.enabled must be true for a required binding.`, `${path}.enabled`);
    return undefined;
  }
  const hasExternal = value.implementationId !== undefined || value.contract !== undefined
    || value.transport !== undefined || value.endpoint !== undefined || value.methods !== undefined
    || value.deployment !== undefined;
  if (value.provider !== undefined && hasExternal) {
    fatal(diagnostics, "MODULE_BINDING_CONFLICT", `${path} must use either provider or protocol binding fields, not both.`, path);
    return undefined;
  }
  if (!hasExternal) {
    if (value.provider !== "pilotdeck") {
      fatal(diagnostics, "MODULE_PROVIDER_UNSUPPORTED", `${path} provider must be pilotdeck or use a protocol binding.`, `${path}.provider`);
      return undefined;
    }
    return { enabled: true, provider: "pilotdeck" };
  }
  return parseExternalModule(name, value, diagnostics);
}

function parseExternalModule(
  slot: ComposableModuleSlot,
  value: Record<string, unknown>,
  diagnostics: PilotConfigDiagnostic[],
): CoreModuleBinding | undefined {
  const path = `modules.${slot}`;
  const implementationId = nonEmptyText(value.implementationId);
  const contract = nonEmptyText(value.contract);
  const transport = nonEmptyText(value.transport);
  const endpoint = nonEmptyText(value.endpoint);
  const manifestPath = nonEmptyText(value.manifestPath) ?? "/module-manifest";
  const callPath = nonEmptyText(value.callPath) ?? "/v2/module/call";
  const timeoutMs = optionalPositiveInteger(value.timeoutMs);
  const parsedMethods = value.methods === undefined ? undefined : readStringArray(value.methods);
  const methods = parsedMethods ?? supportedMethods(slot);
  if (!implementationId) fatal(diagnostics, "MODULE_IMPLEMENTATION_ID_INVALID", `${path}.implementationId must be a non-empty string.`, `${path}.implementationId`);
  if (!contract) fatal(diagnostics, "MODULE_CONTRACT_INVALID", `${path}.contract must be a non-empty string.`, `${path}.contract`);
  if (!transport) fatal(diagnostics, "MODULE_TRANSPORT_INVALID", `${path}.transport must be a non-empty string.`, `${path}.transport`);
  if (slot === "agentLoop") {
    if (value.methods !== undefined && !parsedMethods) fatal(diagnostics, "MODULE_METHODS_INVALID", `${path}.methods must be a non-empty array of unique strings.`, `${path}.methods`);
    return parseExternalAgentLoop(value, diagnostics, implementationId, contract, transport, methods, parsedMethods !== undefined || value.methods === undefined);
  }
  if (!endpoint || !isHttpUrl(endpoint)) fatal(diagnostics, "MODULE_ENDPOINT_INVALID", `${path}.endpoint must be an absolute http(s) URL.`, `${path}.endpoint`);
  if (!manifestPath.startsWith("/")) fatal(diagnostics, "MODULE_MANIFEST_PATH_INVALID", `${path}.manifestPath must start with '/'.`, `${path}.manifestPath`);
  if (!callPath.startsWith("/")) fatal(diagnostics, "MODULE_CALL_PATH_INVALID", `${path}.callPath must start with '/'.`, `${path}.callPath`);
  if (value.timeoutMs !== undefined && timeoutMs === undefined) fatal(diagnostics, "MODULE_TIMEOUT_INVALID", `${path}.timeoutMs must be a positive integer.`, `${path}.timeoutMs`);
  if (value.methods !== undefined && !parsedMethods) fatal(diagnostics, "MODULE_METHODS_INVALID", `${path}.methods must be a non-empty array of unique strings.`, `${path}.methods`);
  if (contract && transport) {
    const error = validateExternalContract({ slot, contract, transport, methods });
    if (error) fatal(diagnostics, "MODULE_CONTRACT_UNSUPPORTED", error, path);
  }
  const tools = slot === "tools" ? readToolCatalog(value.catalog, diagnostics, `${path}.catalog`) : undefined;
  const deployment = parseDeployment(value.deployment, path, diagnostics);
  if (slot === "tools" && (!tools || tools.length === 0)) {
    fatal(diagnostics, "MODULE_TOOL_CATALOG_REQUIRED", `${path}.catalog must declare at least one tool for the synchronous ToolPort list operation.`, `${path}.catalog`);
  }
  if (!implementationId || !contract || transport !== MODULE_HTTP_TRANSPORT || !endpoint || !isHttpUrl(endpoint)) return undefined;
  return {
    enabled: true,
    implementationId,
    contract,
    transport: MODULE_HTTP_TRANSPORT,
    endpoint,
    manifestPath,
    callPath,
    methods,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tools ? { tools } : {}),
    ...(deployment ? { deployment } : {}),
  };
}

function parseExternalAgentLoop(
  value: Record<string, unknown>,
  diagnostics: PilotConfigDiagnostic[],
  implementationId: string | undefined,
  contract: string | undefined,
  transport: string | undefined,
  methods: readonly string[],
  methodsValid: boolean,
): ExternalAgentLoopBinding | undefined {
  const path = "modules.agentLoop";
  if (contract && transport) {
    const error = validateExternalContract({ slot: "agentLoop", contract, transport, methods });
    if (error) fatal(diagnostics, "MODULE_CONTRACT_UNSUPPORTED", error, path);
  }
  if (transport === "module-stdio-v2") {
    const command = nonEmptyText(value.command);
    const args = value.args === undefined ? [] : readStringArrayAllowEmpty(value.args);
    const env = readStringRecord(value.env);
    if (!command) fatal(diagnostics, "MODULE_COMMAND_INVALID", `${path}.command must be a non-empty string.`, `${path}.command`);
    if (value.args !== undefined && !args) fatal(diagnostics, "MODULE_ARGS_INVALID", `${path}.args must be an array of strings.`, `${path}.args`);
    if (value.env !== undefined && !env) fatal(diagnostics, "MODULE_ENV_INVALID", `${path}.env must contain string values.`, `${path}.env`);
    const deployment = parseDeployment(value.deployment, path, diagnostics);
    if (!implementationId || contract !== supportedContract("agentLoop") || !command || !args || !methodsValid) return undefined;
    return { enabled: true, implementationId, contract: MODULE_SLOT_CONTRACTS.agentLoop, transport, methods, command, args, ...(env ? { env } : {}), ...(deployment ? { deployment } : {}) };
  }
  if (transport === "module-tcp-v2") {
    const host = nonEmptyText(value.host);
    const port = optionalPort(value.port);
    const connectTimeoutMs = optionalPositiveInteger(value.connectTimeoutMs);
    const deployment = parseDeployment(value.deployment, path, diagnostics);
    if (!host) fatal(diagnostics, "MODULE_HOST_INVALID", `${path}.host must be a non-empty string.`, `${path}.host`);
    if (!port) fatal(diagnostics, "MODULE_PORT_INVALID", `${path}.port must be an integer between 1 and 65535.`, `${path}.port`);
    if (value.connectTimeoutMs !== undefined && connectTimeoutMs === undefined) fatal(diagnostics, "MODULE_TIMEOUT_INVALID", `${path}.connectTimeoutMs must be a positive integer.`, `${path}.connectTimeoutMs`);
    if (!implementationId || contract !== supportedContract("agentLoop") || !host || !port || !methodsValid) return undefined;
    return { enabled: true, implementationId, contract: MODULE_SLOT_CONTRACTS.agentLoop, transport, methods, host, port, ...(connectTimeoutMs ? { connectTimeoutMs } : {}), ...(deployment ? { deployment } : {}) };
  }
  return undefined;
}

function parseSopModule(
  value: unknown,
  pilotHome: string,
  diagnostics: PilotConfigDiagnostic[],
): SopRuntimeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const path = "modules.sop";
  if (!isRecord(value)) {
    fatal(diagnostics, "SOP_MODULE_INVALID", `${path} must be an object.`, path);
    return undefined;
  }
  if (value.stateMode !== undefined) {
    fatal(
      diagnostics,
      "MODULE_STATE_MODE_UNSUPPORTED",
      `${path}.stateMode is not part of the published SOP contract and cannot be accepted implicitly.`,
      `${path}.stateMode`,
    );
  }
  warnUnknownKeys(value, [
    "enabled", "provider", "implementationId", "contract", "transport", "manifestPath",
    "endpoint", "definitionsPath", "defaultSopId", "timeoutMs", "deployment",
  ], path, diagnostics);
  if (value.enabled === false) return undefined;
  if (value.enabled !== true) {
    fatal(diagnostics, "SOP_MODULE_ENABLED_INVALID", "modules.sop.enabled must be a boolean.", `${path}.enabled`);
    return undefined;
  }
  const hasProtocolBinding = value.implementationId !== undefined || value.contract !== undefined
    || value.transport !== undefined || value.manifestPath !== undefined;
  if (value.provider !== undefined && hasProtocolBinding) {
    fatal(diagnostics, "SOP_MODULE_BINDING_CONFLICT", "modules.sop must use either legacy provider or protocol binding fields, not both.", path);
    return undefined;
  }
  const endpoint = nonEmptyText(value.endpoint);
  if (!endpoint || !isHttpUrl(endpoint)) {
    fatal(diagnostics, "SOP_MODULE_ENDPOINT_INVALID", "modules.sop.endpoint must be an absolute http(s) URL.", `${path}.endpoint`);
  }
  const definitionsPath = nonEmptyText(value.definitionsPath);
  if (!definitionsPath) {
    fatal(diagnostics, "SOP_MODULE_DEFINITIONS_PATH_INVALID", "modules.sop.definitionsPath must be a non-empty path.", `${path}.definitionsPath`);
  }
  const defaultSopId = nonEmptyText(value.defaultSopId);
  if (!defaultSopId) {
    fatal(diagnostics, "SOP_MODULE_DEFAULT_ID_INVALID", "modules.sop.defaultSopId must be a non-empty string.", `${path}.defaultSopId`);
  }
  const timeoutMs = optionalPositiveInteger(value.timeoutMs);
  const deployment = parseDeployment(value.deployment, path, diagnostics);
  if (value.timeoutMs !== undefined && timeoutMs === undefined) {
    fatal(diagnostics, "SOP_MODULE_TIMEOUT_INVALID", "modules.sop.timeoutMs must be a positive integer.", `${path}.timeoutMs`);
  }
  if (!endpoint || !definitionsPath || !defaultSopId) return undefined;
  const base = {
    endpoint,
    definitionsPath: isAbsolute(definitionsPath) ? definitionsPath : resolve(pilotHome, definitionsPath),
    defaultSopId,
    stateRoot: join(pilotHome, "sop"),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(deployment ? { deployment } : {}),
  };
  if (!hasProtocolBinding) {
    if (value.provider !== "staffdeck") {
      fatal(diagnostics, "SOP_MODULE_PROVIDER_INVALID", "modules.sop.provider must be staffdeck or use a protocol binding.", `${path}.provider`);
      return undefined;
    }
    return { provider: "staffdeck", ...base };
  }
  const implementationId = nonEmptyText(value.implementationId);
  if (!implementationId) {
    fatal(diagnostics, "SOP_MODULE_IMPLEMENTATION_ID_INVALID", "modules.sop.implementationId must be a non-empty string.", `${path}.implementationId`);
  }
  if (value.contract !== STAFFDECK_SOP_CONTRACT) {
    fatal(diagnostics, "SOP_MODULE_CONTRACT_UNSUPPORTED", `modules.sop.contract must be ${STAFFDECK_SOP_CONTRACT}.`, `${path}.contract`);
  }
  if (value.transport !== STAFFDECK_SOP_TRANSPORT) {
    fatal(diagnostics, "SOP_MODULE_TRANSPORT_UNSUPPORTED", `modules.sop.transport must be ${STAFFDECK_SOP_TRANSPORT}.`, `${path}.transport`);
  }
  const manifestPath = nonEmptyText(value.manifestPath) ?? "/healthz";
  if (!manifestPath.startsWith("/")) {
    fatal(diagnostics, "SOP_MODULE_MANIFEST_PATH_INVALID", "modules.sop.manifestPath must start with '/'.", `${path}.manifestPath`);
  }
  if (!implementationId || value.contract !== STAFFDECK_SOP_CONTRACT || value.transport !== STAFFDECK_SOP_TRANSPORT || !manifestPath.startsWith("/")) return undefined;
  return {
    ...base,
    implementationId,
    contract: STAFFDECK_SOP_CONTRACT,
    transport: STAFFDECK_SOP_TRANSPORT,
    manifestPath,
  };
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) warning(diagnostics, "MODULE_UNKNOWN_FIELD", `Unknown field '${path}.${key}'.`, `${path}.${key}`);
  }
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim())) return undefined;
  const normalized = value.map((item) => item.trim());
  return new Set(normalized).size === normalized.length ? normalized : undefined;
}

function readStringArrayAllowEmpty(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) return undefined;
  return Object.fromEntries(Object.entries(value) as Array<[string, string]>);
}

function parseDeployment(value: unknown, path: string, diagnostics: PilotConfigDiagnostic[]): ModuleDeployment | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    fatal(diagnostics, "MODULE_DEPLOYMENT_INVALID", `${path}.deployment must be an object.`, `${path}.deployment`);
    return undefined;
  }
  const mode = nonEmptyText(value.mode);
  if (mode !== "build" && mode !== "image" && mode !== "external") {
    fatal(diagnostics, "MODULE_DEPLOYMENT_MODE_INVALID", `${path}.deployment.mode must be build, image, or external.`, `${path}.deployment.mode`);
    return undefined;
  }
  if (mode === "external") return { mode };
  const port = optionalPort(value.port);
  if (!port) fatal(diagnostics, "MODULE_DEPLOYMENT_PORT_INVALID", `${path}.deployment.port must be an integer between 1 and 65535.`, `${path}.deployment.port`);
  const healthPath = value.healthPath === undefined ? undefined : nonEmptyText(value.healthPath);
  if (value.healthPath !== undefined && (!healthPath || !healthPath.startsWith("/"))) {
    fatal(diagnostics, "MODULE_DEPLOYMENT_HEALTH_PATH_INVALID", `${path}.deployment.healthPath must start with '/'.`, `${path}.deployment.healthPath`);
  }
  if (mode === "image") {
    const image = nonEmptyText(value.image);
    if (!image) fatal(diagnostics, "MODULE_DEPLOYMENT_IMAGE_INVALID", `${path}.deployment.image must be a non-empty string.`, `${path}.deployment.image`);
    if (!image || !port) return undefined;
    return { mode, image, port, ...(healthPath ? { healthPath } : {}) };
  }
  const context = nonEmptyText(value.context);
  const dockerfile = value.dockerfile === undefined ? "Dockerfile" : nonEmptyText(value.dockerfile);
  if (!context) fatal(diagnostics, "MODULE_DEPLOYMENT_CONTEXT_INVALID", `${path}.deployment.context must be a non-empty path.`, `${path}.deployment.context`);
  if (!dockerfile) fatal(diagnostics, "MODULE_DEPLOYMENT_DOCKERFILE_INVALID", `${path}.deployment.dockerfile must be a non-empty path.`, `${path}.deployment.dockerfile`);
  if (!context || !dockerfile || !port) return undefined;
  return { mode, context, dockerfile, port, ...(healthPath ? { healthPath } : {}) };
}

function optionalPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
}

function readToolCatalog(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
  path: string,
): ExternalToolDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ExternalToolDescriptor[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || !nonEmptyText(raw.name) || !nonEmptyText(raw.description) || !isRecord(raw.inputSchema)) {
      fatal(diagnostics, "MODULE_TOOL_CATALOG_INVALID", `${path}[${index}] requires name, description, and inputSchema.`, `${path}[${index}]`);
      continue;
    }
    result.push({
      name: nonEmptyText(raw.name)!,
      description: nonEmptyText(raw.description)!,
      inputSchema: raw.inputSchema as ExternalToolDescriptor["inputSchema"],
      ...(typeof raw.kind === "string" ? { kind: raw.kind as ExternalToolDescriptor["kind"] } : {}),
      ...(typeof raw.readOnly === "boolean" ? { readOnly: raw.readOnly } : {}),
      ...(typeof raw.concurrencySafe === "boolean" ? { concurrencySafe: raw.concurrencySafe } : {}),
      ...(typeof raw.requiresUserInteraction === "boolean" ? { requiresUserInteraction: raw.requiresUserInteraction } : {}),
    });
  }
  return result;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function fatal(diagnostics: PilotConfigDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, severity: "fatal", message, path, recoverable: false });
}

function warning(diagnostics: PilotConfigDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, severity: "warning", message, path, recoverable: true });
}
