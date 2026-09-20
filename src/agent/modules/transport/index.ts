export {
  InProcessModuleAdapter,
  ModuleOperationHost,
  type InProcessModuleHandler,
  type InProcessModuleOptions,
} from "./moduleRuntime.js";
export {
  createSidecarPorts,
  type SidecarModuleBinding,
  type SidecarModuleCall,
  type SidecarModuleCallClient,
  type SidecarExecutionPorts,
} from "./sidecarPorts.js";
export {
  createSidecarToolContextBuilder,
  createSidecarToolRuntimeServices,
  createSidecarPermissionRequestContextServices,
  type SidecarToolContextPorts,
} from "./sidecarToolContext.js";
export {
  createSidecarHostModulePorts,
  createSidecarModuleComposition,
  type SidecarModelModulePort,
  type SidecarBudgetModulePort,
  type SidecarCapabilityModulePort,
  type SidecarPermissionModulePort,
  type SidecarPlanTodoModulePort,
  type ToolCatalogPort,
  type ToolRuntimeContextFactoryPort,
  type SidecarToolRuntimeServicesPort,
  type PermissionRequestContextPort,
  type PermissionRequestContextServicesPort,
  type SidecarContextModulePort,
  type SidecarLifecycleModulePort,
  type SidecarEventModulePort,
  type SidecarModuleComposition,
  type SidecarHostModulePorts,
  type SidecarTransportContext,
  type SidecarTransportTurn,
} from "./sidecarHostModulePorts.js";
export { createSidecarDefaultModuleDispatcher, type SidecarModuleManifest } from "./sidecarDefaultModuleDispatcher.js";
export {
  createDefaultSidecarTurnComposition,
  createSidecarModuleHandlerRegistry,
  resolveSidecarTurnCompositionHandlers,
  type SidecarTurnComposition,
  type SidecarTurnCompositionFactory,
} from "./sidecarTurnComposition.js";
export {
  AgentLoopSidecarServer,
  moduleOutcomeFromAgentResult,
  type AgentLoopSidecarOptions,
  type SidecarExecution,
  type SidecarExecutionFactory,
} from "./agentLoopSidecarServer.js";
export {
  createAgentLoopSidecarRuntimeFactory,
  type AgentLoopSidecarConnection,
  type AgentLoopSidecarConnectionFactory,
  type AgentLoopSidecarConnectionFactoryInput,
  type SidecarConnectionFactoryInput,
  type AgentLoopSidecarResultUnknownInput,
  type AgentLoopSidecarResultUnknownReconciler,
  type AgentLoopSidecarResultUnknownResolution,
  type AgentLoopSidecarRuntimeFactoryOptions,
  type SidecarCapabilityResultObserver,
  type SidecarModuleHandler,
  type SidecarModuleHandlerRegistry,
  type SidecarModuleHandlerFactory,
  type SidecarModelHandlerFactoryInput,
  type SidecarBudgetHandlerFactoryInput,
  type SidecarTurnHandlerFactoryInput,
  type SidecarCapabilityHandlerFactoryInput,
  type SidecarPermissionHandlerFactoryInput,
  type SidecarContextHandlerFactoryInput,
  type SidecarLifecycleHandlerFactoryInput,
  type SidecarEventHandlerFactoryInput,
} from "./agentLoopSidecarClient.js";
export type {
  AgentLoopSidecarTransportObservation,
  AgentLoopSidecarTransportObserver,
} from "./sidecarTransportObserver.js";
export {
  createStdioAgentLoopSidecarConnectionFactory,
  type StdioAgentLoopSidecarConnectionFactoryOptions,
} from "./stdioAgentLoopSidecarConnection.js";
export {
  createTcpAgentLoopSidecarConnectionFactory,
  TcpAgentLoopSidecarConnection,
  type TcpAgentLoopSidecarConnectionFactoryOptions,
} from "./tcpAgentLoopSidecarConnection.js";
export {
  AgentLoopSidecarTcpServer,
  type TcpAgentLoopSidecarAddress,
  type TcpAgentLoopSidecarListenOptions,
} from "./tcpAgentLoopSidecarServer.js";
export {
  SessionAgentLoopOperationLedger,
  type SessionAgentLoopOperationLedgerOptions,
} from "./sessionOperationLedger.js";
export {
  SidecarStreamReplayStore,
  type SidecarStreamReplayAck,
  type SidecarStreamReplayResume,
  type SidecarStreamReplayStoreOptions,
} from "./streamReplayStore.js";
export type {
  AgentLoopOperationAccepted,
  AgentLoopOperationIdentity,
  AgentLoopOperationKnownTerminal,
  AgentLoopOperationLedger,
  AgentLoopOperationRecovery,
  AgentLoopOperationResolution,
  AgentLoopOperationUnknownTerminal,
} from "./operationLedger.js";
