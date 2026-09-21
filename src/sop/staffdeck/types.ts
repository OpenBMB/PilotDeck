import type { ModuleDeployment } from "../../composition/types.js";

export const STAFFDECK_SOP_PROTOCOL_VERSION = "2.0" as const;
export const STAFFDECK_SOP_MODULE_ID = "sop.runtime" as const;
export const STAFFDECK_SOP_CONTRACT = "sop.lifecycle/v2" as const;
export const STAFFDECK_SOP_TRANSPORT = "sop-http-v2" as const;
export const STAFFDECK_SOP_OPERATIONS = ["prepare", "submit"] as const;

type SopRuntimeConfigBase = Readonly<{
  endpoint: string;
  definitionsPath: string;
  defaultSopId: string;
  /** Host-owned directory for durable SOP state; never supplied by a client. */
  stateRoot: string;
  timeoutMs?: number;
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
  contract: typeof STAFFDECK_SOP_CONTRACT;
  transport: typeof STAFFDECK_SOP_TRANSPORT;
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
  contract: typeof STAFFDECK_SOP_CONTRACT;
  transport: typeof STAFFDECK_SOP_TRANSPORT;
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

export type StaffDeckSopStatusSnapshot = Readonly<{
  sessionId: string;
  revision: number;
  state: StaffDeckSopState;
  wait?: StaffDeckSopWait;
}>;

export type StaffDeckSopResumeInput = Readonly<{
  sessionId: string;
  requestId: string;
  waitId: string;
  source: "human" | "external_task";
  message: string;
  expectedRevision?: number;
  slotUpdates?: Record<string, unknown>;
}>;

export type StaffDeckSopResumeResult = Readonly<{
  accepted: true;
  duplicate: boolean;
  sessionId: string;
  requestId: string;
  revision: number;
  message: string;
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
  requiredToolNames: string[];
  allowedActions: string[];
  isTerminal: boolean;
  declaresHandoff: boolean;
  subSopId?: string | null;
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
    context?: StaffDeckSopOperationContext;
    signal?: AbortSignal;
  }): Promise<StaffDeckSopSubmitResponse>;
}>;
