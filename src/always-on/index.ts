export type {
  AlwaysOnCurrentWorkspaceRef,
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  AlwaysOnDormantState,
  AlwaysOnChannelLease,
  AlwaysOnEventPhase,
  AlwaysOnPhaseEvent,
  DiscoveryPlanIndex,
  DiscoveryPlanRecord,
  DiscoveryPlanStatus,
  DiscoveryPlanWorkspaceRef,
  DiscoveryRunHistoryEvent,
  DiscoveryFireResult,
  GateBlockReason,
  GateResult,
  WorkCycleIndex,
  WorkCycleRecord,
  WorkCycleStatus,
  WorkspaceHandle,
  WorkspaceStrategyId,
} from "./protocol/types.js";
export { AlwaysOnError, type AlwaysOnErrorCode } from "./protocol/errors.js";
export {
  parseAlwaysOnConfig,
  defaultAlwaysOnConfig,
  DEFAULT_IGNORE_GLOBS,
  type AlwaysOnConfig,
  type AlwaysOnPromptLanguage,
  type AlwaysOnDormancyConfig,
  type AlwaysOnExecutionConfig,
  type AlwaysOnProjectConfig,
  type AlwaysOnTriggerConfig,
  type AlwaysOnWorkspaceConfig,
} from "./config/parseAlwaysOnConfig.js";
export {
  resolveAlwaysOnPaths,
  planMarkdownPath,
  reportMarkdownPath,
  runEventsPath,
  type AlwaysOnPaths,
} from "./storage/AlwaysOnPaths.js";
export { DiscoveryStateStore, defaultDiscoveryState, getDayKey } from "./storage/DiscoveryStateStore.js";
export { DiscoveryPlanStore } from "./storage/DiscoveryPlanStore.js";
export { WorkCycleStore } from "./storage/WorkCycleStore.js";
export { DiscoveryReportStore } from "./storage/DiscoveryReportStore.js";
export { AlwaysOnEventStore } from "./storage/AlwaysOnEventStore.js";
export {
  parsePlanMarkdown,
  PLAN_REQUIRED_SECTIONS,
  PLAN_METADATA_FIRST_LINE,
  PLAN_METADATA_KEYS,
  type PlanContractOptions,
  type PlanMetadata,
  type PlanParseResult,
} from "./contracts/PlanContract.js";
export {
  parseReportMarkdown,
  buildFallbackReport,
  rebuildReport,
  REPORT_METADATA_FIRST_LINE,
  REPORT_REQUIRED_SECTIONS,
  type ReportMetadata,
  type ReportParseResult,
  type BuildFallbackReportInput,
} from "./contracts/ReportContract.js";
export { ChannelLeaseRegistry, type LeaseUpdateInput } from "./runtime/ChannelLeaseRegistry.js";
export {
  evaluateAlwaysOnDiscoveryGates,
  type DiscoveryGateInput,
} from "./runtime/DiscoveryGates.js";
export { SignalWatcher, type SignalWatcherOptions } from "./runtime/SignalWatcher.js";
export {
  AlwaysOnRunContextRegistry,
  type AlwaysOnRunContext,
  type DiscoveryRunContext,
  type WorkspaceRunContext,
  type ExecutionRunContext,
  type ReportRunContext,
} from "./runtime/AlwaysOnRunContextRegistry.js";
export { SessionConfigOverrides, type SessionConfigOverride } from "./runtime/SessionConfigOverrides.js";
export {
  DiscoveryFire,
  acquireDiscoveryLock,
  ensureActiveWorkCycle,
  releaseDiscoveryLock,
  type DiscoveryFireDependencies,
  type DiscoveryFireRunInput,
  type EnsureActiveWorkCycleInput,
  type EnsureActiveWorkCycleResult,
} from "./runtime/DiscoveryFire.js";
export {
  DiscoveryScheduler,
  type DiscoverySchedulerDependencies,
  type DiscoverySchedulerLogger,
} from "./runtime/DiscoveryScheduler.js";
export {
  AlwaysOnRuntime,
  createAlwaysOnRuntime,
  type AlwaysOnRuntimeLogger,
  type CreateAlwaysOnRuntimeOptions,
} from "./runtime/AlwaysOnRuntime.js";
export {
  AlwaysOnManager,
  createAlwaysOnManager,
  type CreateAlwaysOnManagerOptions,
} from "./runtime/AlwaysOnManager.js";
export {
  buildDiscoveryPrompt,
  buildExecutionPrompt,
  buildWorkspacePrompt,
  buildReportPrompt,
  type BuildDiscoveryPromptInput,
  type BuildWorkspacePromptInput,
  type BuildExecutionPromptInput,
  type BuildReportPromptInput,
} from "./runtime/discoveryPrompts.js";
export {
  createAlwaysOnDiscoveryPlanTool,
  ALWAYS_ON_PLAN_TOOL_NAME,
  type AlwaysOnDiscoveryPlanInput,
  type AlwaysOnDiscoveryPlanOutput,
  type CreateAlwaysOnDiscoveryPlanToolOptions,
} from "./tool/AlwaysOnDiscoveryPlanTool.js";
export {
  createAlwaysOnReportTool,
  ALWAYS_ON_REPORT_TOOL_NAME,
  type AlwaysOnReportInput,
  type AlwaysOnReportOutput,
  type CreateAlwaysOnReportToolOptions,
} from "./tool/AlwaysOnReportTool.js";
export {
  createAlwaysOnWorkspaceTool,
  ALWAYS_ON_WORKSPACE_TOOL_NAME,
  type AlwaysOnWorkspaceInput,
  type AlwaysOnWorkspaceOutput,
  type CreateAlwaysOnWorkspaceToolOptions,
} from "./tool/AlwaysOnWorkspaceTool.js";
export { createApplyHandler, type CreateApplyHandlerDeps } from "./runtime/createApplyHandler.js";
export type { WorkspaceProvider, WorkspaceProviderId, WorkspacePrepareInput, WorkspacePublishOutput } from "./workspace/WorkspaceProvider.js";

// Web-facing presentation & lifecycle services (shared by UI/CLI/SDK)
export {
  computeExecutionStatus,
  computePlanStatus,
  sortDiscoveryPlans,
  toTimestampValue,
  toIsoTimestamp,
  pickLatestIsoTimestamp,
  normalizeString as webNormalizeString,
  truncateText,
  normalizeStringList,
  PLAN_STATUS_ORDER,
  type WebCycleRecord,
  type WebPlanRecord,
  type WebPlanSession,
  type WebPlanContextRefs,
  type WebPlanStatus,
} from "./web/DiscoveryPlanStatus.js";
export { DiscoveryPlanService, normalizeDiscoveryPlanRecord, type DiscoveryPlanServiceDeps } from "./web/DiscoveryPlanService.js";
export { buildDiscoveryContext, type DiscoveryContextDeps } from "./web/DiscoveryPlanContext.js";
export { AlwaysOnRunHistoryService, type AlwaysOnRunHistoryServiceDeps, type RunHistoryEntry, type RunHistoryDetailEntry } from "./web/AlwaysOnRunHistoryService.js";
export { GitWorktreeProvider, type GitWorktreeProviderOptions } from "./workspace/GitWorktreeProvider.js";
export { SnapshotCopyProvider, type SnapshotCopyProviderOptions } from "./workspace/SnapshotCopyProvider.js";
export { WorkspaceProviderRegistry } from "./workspace/WorkspaceProviderRegistry.js";
