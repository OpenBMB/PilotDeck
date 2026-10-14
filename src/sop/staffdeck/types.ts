import type { ModuleDeployment } from "../../composition/types.js";
import type { SopAuthorityProjection } from "../../composition/sopCapabilityAuthority.js";

export const STAFFDECK_SOP_PROTOCOL_VERSION = "2.0" as const;
export const STAFFDECK_SOP_MODULE_ID = "sop.runtime" as const;
export const STAFFDECK_SOP_CONTRACT = "sop.lifecycle/v2" as const;
export const STAFFDECK_SOP_TRANSPORT = "sop-http-v2" as const;
export const STAFFDECK_SOP_OPERATIONS = ["prepare", "submit"] as const;

export type StaffDeckSopContextMode = "new_session" | "inherit";

type SopRuntimeConfigBase = Readonly<{
  hostAdapter?: "pilotdeck" | "staffdeck";
  endpoint: string;
  definitionsPath: string;
  defaultSopId: string;
  /** Optional StaffDeck-native discovery/route API. */
  discoveryEndpoint?: string;
  discoveryAgentId?: string;
  discoveryApiKey?: string;
  discoveryPath?: string;
  discoveryTimeoutMs?: number;
  /** Host-owned directory for durable SOP state; never supplied by a client. */
  stateRoot: string;
  timeoutMs?: number;
  /** How a SOP node receives model messages when no node override is present. */
  contextMode?: StaffDeckSopContextMode;
  capabilityBindings?: readonly Readonly<{ capabilityId: string; toolName: string; kind: "tool" | "skill" | "knowledge" }>[];
  runtimeSopScope?: Readonly<{ tenantId: string; agentId: string }>;
  deployment?: ModuleDeployment;
  /** Optional static frontend registry key selected by the profile. */
  frontendModule?: string;
}>;

/** Legacy shorthand retained for existing StaffDeck deployments. */
export type StaffDeckSopRuntimeConfig = SopRuntimeConfigBase & Readonly<{
  provider: "staffdeck";
}>;

/** Versioned HTTP boundary between the PilotDeck host and StaffDeck SOP owner. */
export type ProtocolSopRuntimeConfig = SopRuntimeConfigBase & Readonly<{
  implementationId: string;
  contract: typeof STAFFDECK_SOP_CONTRACT | "sop.lifecycle/v3";
  transport: typeof STAFFDECK_SOP_TRANSPORT | "sop-http-v3";
  manifestPath: string;
}>;

/** A legacy StaffDeck binding or a protocol-selected implementation. */
export type SopRuntimeConfig = StaffDeckSopRuntimeConfig | ProtocolSopRuntimeConfig;

export type StaffDeckSopOperation = (typeof STAFFDECK_SOP_OPERATIONS)[number];

export type StaffDeckSopModuleManifest = Readonly<{
  status: "ok";
  protocolVersion: typeof STAFFDECK_SOP_PROTOCOL_VERSION;
  moduleId: typeof STAFFDECK_SOP_MODULE_ID;
  contract: typeof STAFFDECK_SOP_CONTRACT;
  operations: StaffDeckSopOperation[];
  descriptorVersion?: "1.0";
  implementationId?: string;
  implementationVersion?: string;
  transport?: typeof STAFFDECK_SOP_TRANSPORT;
  capabilities?: string[];
  state?: Readonly<{ ownership: "host"; schema: string; scope: "session" }>;
  requires?: Readonly<{ hostCapabilities?: string[] }>;
}>;

export type SopRuntimeManifestExpectation = Readonly<{
  implementationId: string;
  contract: typeof STAFFDECK_SOP_CONTRACT | "sop.lifecycle/v3";
  transport: typeof STAFFDECK_SOP_TRANSPORT | "sop-http-v3";
}>;

/** Host execution identity forwarded to the stateless SOP runtime. */
export type StaffDeckSopOperationContext = Readonly<{
  runId: string;
  operationId: string;
  requestId: string;
  sessionId: string;
  turnId: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  expectedRevision?: number;
}>;

export type StaffDeckSopRequestEnvelope = Readonly<{
  protocolVersion: typeof STAFFDECK_SOP_PROTOCOL_VERSION;
  runId: string;
  operationId: string;
  requestId: string;
  sessionId: string;
  turnId: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  expectedRevision?: number;
  payload: Record<string, unknown>;
}>;

export type StaffDeckSopRuntimeError = Readonly<{
  code: string;
  message: string;
  retryability: "safe" | "unsafe" | "retry_after_status";
  details?: Record<string, unknown>;
}>;

export type StaffDeckSopResponseEnvelope = Readonly<{
  protocolVersion: typeof STAFFDECK_SOP_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  outcome: "completed" | "failed";
  payload?: Record<string, unknown>;
  error?: StaffDeckSopRuntimeError;
}>;

export type StaffDeckSopBundle = Readonly<{
  sops: readonly Record<string, unknown>[];
}>;

export type StaffDeckSopState = Record<string, unknown> & {
  selected_skill_id?: string;
  active_skill_id?: string;
  active_step_id?: string;
  status?: string;
  slots_json?: Record<string, unknown>;
  skill_stack_json?: Record<string, unknown>[];
  successful_tool_names?: string[];
};

export type StaffDeckSopWaitKind = "handoff" | "external_task";

export type StaffDeckSopWait = Readonly<{
  id: string;
  kind: StaffDeckSopWaitKind;
  skillId?: string;
  stepId?: string;
  createdAt: string;
}>;

/** Created by the authenticated host root, never deserialized from browser input. */
export type StaffDeckApprovalAuthority = Readonly<{
  hostAdapter?: "pilotdeck" | "staffdeck";
  tenantId: string;
  sessionId: string;
  subject: Readonly<{ tenantId: string; userId: string; source: "web"; role: "admin" | "member"; disabled: boolean }>;
}>;

export type StaffDeckPinnedApproval = Readonly<{
  waitId: string;
  revision: number;
  skillId: string;
  version: string;
  nodeId: string;
  assigneeUserId: string;
}>;

export type StaffDeckSopStatusSnapshot = Readonly<{
  sessionId: string;
  revision: number;
  state: StaffDeckSopState;
  wait?: StaffDeckSopWait;
  approval?: StaffDeckPinnedApproval;
  approvalError?: Readonly<{ code: string; message: string }>;
}>;

/** Host-owned facts that may be projected into the model context. */
export type StaffDeckSopModelContext = Readonly<{
  sopId?: string;
  stepId?: string;
  assigneeUserId?: string;
}>;

export type StaffDeckSopResumeInput = Readonly<{
  sessionId: string;
  requestId: string;
  waitId: string;
  source: "human" | "external_task";
  message: string;
  expectedRevision?: number;
  slotUpdates?: Record<string, unknown>;
  authority?: StaffDeckApprovalAuthority;
}>;

export type StaffDeckSopResumeResult = Readonly<{
  accepted: true;
  duplicate: boolean;
  sessionId: string;
  requestId: string;
  revision: number;
  message: string;
}>;

export type StaffDeckSopTransition = Readonly<{
  nextStepId: string;
  condition: string;
  priority: number;
  label?: string;
  targetStep: Record<string, unknown>;
}>;

export type StaffDeckSopStep = Readonly<{
  skillId: string;
  skillName: string;
  version: string;
  nodeId: string;
  node: Record<string, unknown>;
  instruction: string;
  expectedUserInfo: string[];
  knownSlots: Record<string, unknown>;
  allowedNextStepIds: string[];
  transitions?: StaffDeckSopTransition[];
  requiredToolNames: string[];
  allowedActions: string[];
  isTerminal: boolean;
  declaresHandoff: boolean;
  /** Whether this node starts with a fresh model context or inherits history. */
  contextMode?: StaffDeckSopContextMode;
  subSopId?: string | null;
  /** Host-only projection; never accepted from portable evaluator/model input. */
  optionalKnowledge?: SopAuthorityProjection;
  optionalKnowledgeUnavailable?: string;
}>;

export type StaffDeckSopPrepareResponse = Readonly<{
  state: StaffDeckSopState;
  step: StaffDeckSopStep;
}>;

export type StaffDeckSopProposal = Readonly<{
  status: "completed" | "awaiting_user" | "handoff" | "failed" | "blocked" | "waiting_external_task";
  replyFragment: string;
  slotUpdates?: Record<string, unknown>;
  taskSummary?: string;
  structuredResult?: unknown;
  nextStepId?: string;
}>;

export type StaffDeckSopSubmitResult = Readonly<{
  status: string;
  replyFragment: string;
  slotUpdates: Record<string, unknown>;
  taskSummary?: string;
  structuredResult?: unknown;
  nextStepId?: string | null;
  events: Array<Record<string, unknown>>;
}>;

export type StaffDeckSopSubmitResponse = Readonly<{
  state: StaffDeckSopState;
  result: StaffDeckSopSubmitResult;
}>;

export type StaffDeckSopReplyDelivery = Readonly<{
  turnId: string;
  phase: "pending" | "durable";
  result: StaffDeckSopSubmitResult;
  committedAt: string;
  durableAt?: string;
}>;

export type StaffDeckSopRuntimeClient = Readonly<{
  prepare(input: {
    bundle: StaffDeckSopBundle;
    state: StaffDeckSopState;
    context?: StaffDeckSopOperationContext;
    signal?: AbortSignal;
  }): Promise<StaffDeckSopPrepareResponse>;
  submit(input: {
    bundle: StaffDeckSopBundle;
    state: StaffDeckSopState;
    proposal: StaffDeckSopProposal;
    successfulToolNames: readonly string[];
    receipts?: readonly import("./PortableSopRuntimeClient.js").PortableSopReceipt[];
    context?: StaffDeckSopOperationContext;
    signal?: AbortSignal;
  }): Promise<StaffDeckSopSubmitResponse>;
}>;

export type StaffDeckSopRouteResult = Readonly<{
  decision: string;
  candidateSopIds?: readonly string[];
  selectedSopId?: string | null;
  targetStepId?: string | null;
  confidence?: number;
  userIntent?: string | null;
  reason?: string | null;
  clarificationQuestion?: string | null;
}>;

export type StaffDeckSopDiscoveryPort = Readonly<{
  route(input: {
    message: string;
    sessionId: string;
    activeSopId?: string;
    activeStepId?: string;
    slots?: Record<string, unknown>;
    pendingTasks?: readonly Record<string, unknown>[];
    awaitingInput?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<StaffDeckSopRouteResult>;
}>;
