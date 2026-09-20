export { HttpModuleClient, type ModuleCallInput } from "./HttpModuleClient.js";
export {
  composeToolPorts,
  createRuntimeModulePorts,
  type ResolvedRuntimeModulePorts,
  type RuntimeModuleBindings,
} from "./runtimePorts.js";
export {
  createKnowledgeModulePort,
  createKnowledgeQueryTool,
  createSkillManagementPort,
  createSkillModulePort,
  type KnowledgeModulePort,
  type SkillManagementPort,
  type SkillModulePort,
} from "./domainPorts.js";
export { supportedContract, supportedMethods, validateExternalContract } from "./registry.js";
export {
  MODULE_HTTP_TRANSPORT,
  MODULE_SLOT_CONTRACTS,
  isDisabledModuleBinding,
  isExternalAgentLoopBinding,
  isExternalModuleBinding,
  type ComposableModuleSlot,
  type CoreModuleBinding,
  type DisabledModuleBinding,
  type ExternalModuleBinding,
  type ExternalAgentLoopBinding,
  type ExternalToolDescriptor,
  type ModuleDeployment,
  type NativeModuleBinding,
} from "./types.js";
