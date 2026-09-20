export { AgentLoop, type AgentLoopInput, type AgentLoopRunResult, type AgentLoopSeedState } from "./loop/AgentLoop.js";
export {
  createSidecarAgentTurnCapabilities,
  isAgentTurnCapabilities,
  isNoopAgentTurnContextPort,
  type AgentTurnCapabilities,
  type AgentTurnContextPort,
  type ContextPreparationPort,
  type ContextRecoveryPort,
  type ContextToolResultPort,
  type ContextCapturePort,
  type ContextCompactionPort,
  type AgentTurnModelCapabilities,
  type AgentTurnRoutingPort,
  type SidecarAgentTurnCapabilityComposition,
  type SidecarAgentLoopPorts,
  type ModelExecutionPort,
  type ModelMetadataPort,
  type ModelBudgetPort,
  type AuxiliaryModelPort,
  type ToolExecutionPort,
  type PermissionPort,
  type InteractionPort,
  type PlanModePort,
  type SubagentPort,
  type AgentTurnToolCapabilities,
  type LifecycleDispatchPort,
  type ToolResultObserver,
} from "./loop/AgentTurnCapabilities.js";
export {
  createAgentTurnCapabilities,
  type AgentTurnCapabilityComposition,
} from "./loop/nativeAgentTurnCapabilitiesAdapter.js";
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
  type SidecarBudgetHandlerFactoryInput,
  type SidecarTurnHandlerFactoryInput,
  type SidecarModelHandlerFactoryInput,
  type SidecarCapabilityHandlerFactoryInput,
  type SidecarPermissionHandlerFactoryInput,
  type SidecarContextHandlerFactoryInput,
  type SidecarLifecycleHandlerFactoryInput,
  type SidecarEventHandlerFactoryInput,
} from "./modules/transport/agentLoopSidecarClient.js";
export {
  createDefaultSidecarTurnComposition,
  createSidecarModuleHandlerRegistry,
  type SidecarTurnComposition,
  type SidecarTurnCompositionFactory,
} from "./modules/transport/sidecarTurnComposition.js";
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
} from "./modules/transport/sidecarHostModulePorts.js";
export {
  createSidecarDefaultModuleDispatcher,
  type SidecarModuleManifest,
} from "./modules/transport/sidecarDefaultModuleDispatcher.js";
export type {
  AgentLoopSidecarTransportObservation,
  AgentLoopSidecarTransportObserver,
} from "./modules/transport/sidecarTransportObserver.js";
export {
  createHostPlanTodoPort,
  createPlanTodoAwareToolPort,
  createPlanTodoResultObserver,
  type HostPlanTodoModuleClient,
  type HostPlanTodoPort,
  type HostPlanTodoPortOptions,
} from "./modules/capability/hostPlanTodoPort.js";
export {
  createHostLifecycleRuntime,
  HostLifecycleRuntime,
  type HostLifecycleModuleBinding,
  type HostLifecycleModuleClient,
} from "./modules/lifecycle/hostLifecycleRuntime.js";
export {
  createHostAgentEventBridge,
  type HostAgentEventBridge,
  type HostEventModuleBinding,
  type HostEventModuleClient,
} from "./modules/events/hostAgentEventBridge.js";
export {
  SessionAgentLoopOperationLedger,
  type SessionAgentLoopOperationLedgerOptions,
  type AgentLoopOperationAccepted,
  type AgentLoopOperationIdentity,
  type AgentLoopOperationKnownTerminal,
  type AgentLoopOperationLedger,
  type AgentLoopOperationRecovery,
  type AgentLoopOperationResolution,
  type AgentLoopOperationUnknownTerminal,
} from "./modules/transport/index.js";
export {
  createStdioAgentLoopSidecarConnectionFactory,
  type StdioAgentLoopSidecarConnectionFactoryOptions,
} from "./modules/transport/stdioAgentLoopSidecarConnection.js";
export {
  createTcpAgentLoopSidecarConnectionFactory,
  TcpAgentLoopSidecarConnection,
  type TcpAgentLoopSidecarConnectionFactoryOptions,
} from "./modules/transport/tcpAgentLoopSidecarConnection.js";
export {
  AgentLoopSidecarTcpServer,
  type TcpAgentLoopSidecarAddress,
  type TcpAgentLoopSidecarListenOptions,
} from "./modules/transport/tcpAgentLoopSidecarServer.js";
export type {
  AgentLoopRuntimeFactory,
  AgentLoopRuntimeFactoryInput,
} from "./loop/AgentLoopRuntimeFactory.js";
export {
  createNativeSubagentProvider,
  type ContinuableSubagentCreateSpec,
  type ContinuableSubagentPrepareRequest,
  type ResolvedSubagentRunRequest,
  type SubagentProvider,
  type SubagentRunRequest,
} from "./sub/SubagentProvider.js";
export {
  createNativeOneShotSubagentPort,
  type OneShotSubagentPort,
  type OneShotSubagentPortRequest,
  type OneShotSubagentPortOptions,
} from "./sub/OneShotSubagentPort.js";
export {
  SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION,
  SUBAGENT_DESCRIPTOR_VERSION,
  foldSubagentDescriptor,
  parseSubagentDescriptor,
  snapshotSubagentDescriptor,
  type ContinuableSubagentDescriptorData,
  type ContinuableSubagentDescriptorInput,
  type OneShotSubagentDescriptorData,
  type OneShotSubagentDescriptorInput,
  type SubagentDescriptorData,
  type SubagentDescriptorInput,
} from "./sub/SubagentDescriptor.js";
export {
  SUBAGENT_DESCRIPTOR_METADATA_KEY,
  recordSubagentAcceptedInputWithDescriptor,
} from "./sub/SubagentDescriptorPersistence.js";
export {
  SubagentProviderRegistry,
  type PreparedContinuableSubagent,
  type SubagentProviderLifecycleEvent,
  type SubagentProviderLifecycleSubscription,
  type SubagentProviderRegistryState,
  type SubagentProviderRegistration,
  type SubagentProviderReplacement,
  type SubagentProviderRegistrationOptions,
} from "./sub/SubagentProviderRegistry.js";
export {
  SubagentContinuationManager,
  type ContinuableSubagentActivationSnapshot,
  type ContinuableSubagentAdmission,
  type ContinuableSubagentInspection,
  type ContinuableSubagentInspectRequest,
  type ContinuableSubagentMaterializeRequest,
  type ContinuableSubagentResumeRequest,
  type FollowupContinuableSubagentRequest,
  type StartContinuableSubagentRequest,
  type SubagentContinuationAgentDirectory,
  type SubagentContinuationHost,
  type SubagentContinuationManagerOptions,
  type SubagentContinuationManagerState,
} from "./sub/SubagentContinuationManager.js";
export { bindSubagentContinuationPort } from "./sub/SubagentContinuationPort.js";
export {
  NativeSubagentContinuationHost,
  type NativeSubagentChildConfigurator,
  type NativeSubagentContinuationHostOptions,
  type NativeSubagentParentBinding,
} from "./sub/NativeSubagentContinuationHost.js";
export { collectToolCalls } from "./loop/collectToolCalls.js";
export { decideLoopContinuation, type LoopContinuationDecision } from "./loop/decideLoopContinuation.js";
export { createMissingToolResult, ensureToolResultPairing } from "./loop/ensureToolResultPairing.js";
export { projectToolResults } from "./loop/projectToolResults.js";
export { AgentSession, type AgentSessionOptions } from "./session/AgentSession.js";
export {
  AgentTurnInbox,
  type AgentQueuedTurn,
  type AgentTurnDiscardReason,
  type AgentTurnInboxOptions,
} from "./session/AgentTurnInbox.js";
export {
  AgentSessionEventRecorder,
  type CompactionCompletedDraft,
  type CompactionFailedDraft,
  type CompactionStartedDraft,
  type InboxMutationDraft,
  type QuestionCompletedDraft,
  type QuestionFailedDraft,
  type QuestionStartedDraft,
  type PermissionCompletedDraft,
  type PermissionFailedDraft,
  type PermissionStartedDraft,
} from "./session/AgentSessionEventRecorder.js";
export {
  ManualCompactionController,
  type ManualCompactionControllerOptions,
  type ManualCompactionRequest,
  type ManualCompactionResult,
} from "./session/ManualCompactionController.js";
export {
  appendPermissionDenials,
  createInitialAgentSessionState,
  mergeSessionUsage,
  snapshotAgentSessionState,
} from "./session/AgentSessionState.js";
export {
  createAgentSession,
  createAgentSessionWithStorage,
  createAgentSessionWithStorageAsync,
  type AgentSessionConfigureContext,
  type AgentSessionDisposer,
  type CreatedAgentSession,
  type CreateAgentSessionOptions,
} from "./session/createAgentSession.js";
export { AgentRuntimeError, agentError, normalizeAgentError, type AgentError, type AgentErrorCode } from "./protocol/errors.js";
export { createAgentEventBuffer, type AgentEvent, type AgentEventEmitter, type AgentEventBufferHandle } from "./protocol/events.js";
export {
  AGENT_RUN_MODES,
  parseAgentRunMode,
  type AgentInput,
  type AgentRunMode,
  type AgentSubmitOptions,
} from "./protocol/input.js";
export type { AgentPermissionDenial, AgentStopReason, AgentTurnResult } from "./protocol/result.js";
export type { AgentLoopState, AgentLoopTransition, AgentLoopTransitionReason, AgentSessionState } from "./protocol/state.js";
export type { AgentRuntimeConfig } from "./runtime/AgentRuntimeConfig.js";
export type {
  AgentLegacyModelRuntime,
  AgentRouterRuntime,
  AgentRuntimePorts,
  AgentRuntimeDependencies,
} from "./runtime/AgentRuntimeDependencies.js";
export {
  AgentHandle,
  AgentFactoryProvider,
  AgentRegistry,
  AgentRuntimeScope,
  AgentScopeLiveEventBus,
  AGENT_RUNTIME_SCOPE_TOKENS,
  ScopedServiceRegistry,
  asAgentHandle,
  createScopedServiceToken,
  type AgentFollowupOptions,
  type AgentCompactOptions,
  type AgentHandleOptions,
  type AgentHandleState,
  type AgentFactoryProviderOptions,
  type AgentFactoryProviderState,
  type AgentPublicationOptions,
  type AgentReplacement,
  type AgentRegistryOptions,
  type AgentRuntimeScopeEffect,
  type AgentRuntimeScopeOptions,
  type AgentRuntimeScopeServices,
  type AgentScopeLiveEvent,
  type AgentScopeLiveEventBusOptions,
  type AgentScopeLiveEventBusState,
  type AgentScopeLiveEventHandler,
  type AgentScopeLiveEventSubscriberErrorHandler,
  type AgentScopeLiveEventSubscription,
  type ScopedServiceLease,
  type ScopedServiceProviderOptions,
  type ScopedServiceRegistration,
  type ScopedServiceRegistrationState,
  type ScopedServiceReplacement,
  type ScopedServiceRegistryOptions,
  type ScopedServiceRegistryState,
  type ScopedServiceToken,
} from "./scope/index.js";
export {
  MODULE_PROTOCOL_VERSION,
  InProcessModuleAdapter,
  ModuleOperationHost,
  AgentLoopSidecarServer,
  validateModuleMessage,
  createRouterModelInvokerPort,
  createToolSchedulerPort,
} from "./modules/index.js";
export type {
  AgentExecutionContext,
  ModelExecutionContext,
  ModelInvokerPort,
  ModuleBinding,
  ModuleCapabilities,
  ModuleControlRequest,
  ModuleError,
  ModuleEvent,
  ModuleExecuteProfile,
  ModuleExecuteRequest,
  ModuleHandshakeRequest,
  ModuleMessage,
  ModuleOperationSnapshot,
  ModuleOperationState,
  ModuleOutcome,
  ModuleProtocolValidation,
  ModuleResponse,
  ModuleRetryability,
  PreparedModelInvocation,
  AgentLoopSidecarOptions,
  ToolPort,
  InProcessModuleHandler,
  InProcessModuleOptions,
} from "./modules/index.js";
export { TurnInputProcessor, type TurnInputProcessorResult } from "./turn/TurnInputProcessor.js";
export type { AgentInputAdmission, AgentInputAdmissionResult } from "./turn/InputAdmission.js";
export {
  TurnRunner,
  type AgentLoopRunner,
  type TurnRunnerOptions,
  type TurnRunnerResult,
  type TurnRunnerRuntimeContext,
} from "./turn/TurnRunner.js";
