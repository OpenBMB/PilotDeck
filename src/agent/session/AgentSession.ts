import { randomUUID } from "node:crypto";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import type { AgentTranscriptReplayResult } from "../../session/transcript/TranscriptReplay.js";
import type { TurnRunner } from "../turn/TurnRunner.js";
import {
  appendPermissionDenials,
  cloneSessionStateForRuntimeReload,
  createInitialAgentSessionState,
  mergeSessionUsage,
  snapshotAgentSessionState,
} from "./AgentSessionState.js";
import {
  AGENT_TRANSCRIPT_PROJECTION_NAMES,
  type AgentConversationProjectionResult,
  type AgentTurnSummaryProjectionResult,
} from "../../session/projection/AgentTranscriptProjections.js";
import {
  requireSessionProjectionValue,
  type SessionProjectionSnapshot,
} from "../../session/projection/SessionProjection.js";
import type {
  AgentStatusMessageInput,
  AgentTranscriptWriterState,
} from "../../session/transcript/TranscriptWriter.js";
import type { AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import type { CanonicalMessage } from "../../model/index.js";
import {
  SteerMailbox,
  type AgentCancelSteerResult,
  type AgentSteerResult,
} from "./SteerMailbox.js";
import type { AgentSessionEventRecorder } from "./AgentSessionEventRecorder.js";
import {
  AgentTurnInbox,
  type AgentQueuedTurn,
  type AgentTurnDiscardReason,
} from "./AgentTurnInbox.js";
import type {
  AgentSubagentDescriptorData,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type {
  ManualCompactionController,
  ManualCompactionResult,
} from "./ManualCompactionController.js";

export type AgentSessionOptions = {
  sessionId: string;
  turnRunner: TurnRunner;
  cwd?: string;
  transcriptPath?: string;
  uuid?: () => string;
  initialState?: AgentSessionStateShape;
  replayEvents?: AgentEvent[];
  lifecycle?: LifecycleRuntime;
  eventRecorder?: AgentSessionEventRecorder;
  restoredEntries?: readonly AgentTranscriptEntry[];
  projections?: {
    snapshot(names?: readonly string[]): SessionProjectionSnapshot;
  };
  /** Session-owned human maintenance consumer; absent only in minimal legacy fixtures. */
  manualCompactionController?: ManualCompactionController;
};

export type AgentSessionRuntimeReloadSnapshot = {
  state: AgentSessionStateShape;
  cwd: string;
  transcriptPath: string;
  transcriptWriterState?: AgentTranscriptWriterState;
  fileState?: AgentLoopSeedState;
  metadata?: SessionMetadataValue;
};

export class AgentSession {
  private state: AgentSessionStateShape;
  private readonly steerMailbox: SteerMailbox;
  private readonly eventRecorder: AgentSessionEventRecorder;
  private readonly turnInbox: AgentTurnInbox;

  constructor(private readonly options: AgentSessionOptions) {
    this.state = options.initialState ?? createInitialAgentSessionState(options.sessionId);
    const recorder = options.eventRecorder ?? options.turnRunner.sessionEventRecorder;
    this.eventRecorder = recorder;
    this.turnInbox = new AgentTurnInbox({
      sessionId: options.sessionId,
      recorder,
      restoredEntries: options.restoredEntries,
    });
    this.steerMailbox = new SteerMailbox({
      recordMutation: (turnId, mutation) => recorder.recordInboxMutation(options.sessionId, turnId, mutation),
    });
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** Write a status through the exact live session runtime. */
  recordAgentStatusMessage(turnId: string, status: AgentStatusMessageInput): Promise<boolean> {
    return this.options.turnRunner.recordAgentStatusMessage(this.options.sessionId, turnId, status);
  }

  async *submit(input: AgentInput, submitOptions: AgentSubmitOptions = {}): AsyncGenerator<AgentEvent, void, unknown> {
    yield* this.submitInternal(input, submitOptions, false);
  }

  async compact(input: { abortSignal: AbortSignal; turnId: string }): Promise<ManualCompactionResult> {
    const controller = this.options.manualCompactionController;
    if (!controller) {
      throw new Error("Manual compaction is unavailable for this agent session.");
    }
    if (this.state.status === "running" || this.state.currentTurnId !== undefined) {
      throw new Error("Agent session is not idle for manual compaction.");
    }
    this.state.status = "running";
    this.state.currentTurnId = input.turnId;
    try {
      const result = await controller.compact(input);
      return result;
    } finally {
      this.state.currentTurnId = undefined;
      // Manual maintenance is terminalized in the durable turn result. A
      // failed/aborted command must leave the agent reusable for a retry;
      // live busy ownership is held by AgentHandle rather than this snapshot.
      this.state.status = "idle";
    }
  }

  get pendingTurnCount(): number {
    return this.turnInbox.size;
  }

  pendingTurns(): readonly AgentQueuedTurn[] {
    return this.turnInbox.snapshot();
  }

  enqueueTurn(turn: AgentQueuedTurn): Promise<void> {
    return this.turnInbox.enqueue(turn);
  }

  recordSubagentDescriptor(
    turnId: string,
    descriptor: AgentSubagentDescriptorData,
  ): void | Promise<void> {
    return this.eventRecorder.recordSubagentDescriptor(this.options.sessionId, turnId, descriptor);
  }

  discardQueuedTurn(itemId: string, reason: AgentTurnDiscardReason): Promise<boolean> {
    return this.turnInbox.discard(itemId, reason);
  }

  discardQueuedTurns(reason: AgentTurnDiscardReason): Promise<void> {
    return this.turnInbox.discardAll(reason);
  }

  async *submitQueuedTurn(turn: AgentQueuedTurn): AsyncGenerator<AgentEvent, void, unknown> {
    const pending = this.turnInbox.peek();
    if (!pending || pending.itemId !== turn.itemId || pending.turnId !== turn.turnId) {
      throw new Error(`Queued turn ${turn.itemId} is not the next FIFO admission.`);
    }
    await this.eventRecorder.startTurn(this.options.sessionId, turn.turnId, turn.itemId);
    this.turnInbox.markStarted(turn.itemId, turn.turnId);
    yield* this.submitInternal(turn.input, {
      ...turn.submitOptions,
      turnId: turn.turnId,
    }, true);
  }

  private async *submitInternal(
    input: AgentInput,
    submitOptions: AgentSubmitOptions,
    turnAlreadyStarted: boolean,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const turnId = submitOptions.turnId ?? this.nextId();
    this.state.status = "running";
    this.state.currentTurnId = turnId;
    this.state.abortController = new AbortController();
    yield { type: "session_started", sessionId: this.state.sessionId };
    await this.options.lifecycle?.dispatch({
      event: "SessionStart",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: { source: "startup" },
      matchQuery: "SessionStart",
      signal: this.state.abortController.signal,
    });
    await this.options.lifecycle?.dispatch({
      event: "Setup",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: {},
      matchQuery: "Setup",
      signal: this.state.abortController.signal,
    });
    yield { type: "setup_completed", sessionId: this.state.sessionId };

    let runResult;
    try {
      runResult = yield* this.options.turnRunner.run({
        sessionId: this.state.sessionId,
        turnId,
        messages: this.projectedMessages(),
        input,
        execution: submitOptions.execution,
        workspaceId: submitOptions.workspaceId,
        storageConfigVersion: submitOptions.storageConfigVersion,
        invocationLogSink: submitOptions.invocationLogSink,
        maxTurns: submitOptions.maxTurns,
        maxBudgetUsd: submitOptions.maxBudgetUsd,
        taskBudgetUsd: submitOptions.taskBudgetUsd,
        initialTaskBudgetSpentUsd: submitOptions.initialTaskBudgetSpentUsd,
        runMode: submitOptions.runMode,
        permissionMode: submitOptions.permissionMode,
        allowedReadFiles: submitOptions.allowedReadFiles,
        basePermissionMode: submitOptions.basePermissionMode,
        allowPlanModeTools: submitOptions.allowPlanModeTools,
        canPrompt: submitOptions.canPrompt,
        canElicit: submitOptions.canElicit,
        permissionRules: submitOptions.permissionRules,
        syntheticMessages: submitOptions.syntheticMessages,
        modelOverride: submitOptions.modelOverride,
        modelSelection: submitOptions.modelSelection,
        abortSignal: this.state.abortController.signal,
        openSteerMailbox: () => this.steerMailbox.start(turnId),
        drainSteerMessages: () => this.steerMailbox.drain(turnId),
        drainOrCloseSteerMailbox: () => this.steerMailbox.drainOrClose(turnId),
        claimSteerMessage: (itemId) => this.steerMailbox.claim(turnId, itemId),
        ackSteerMessage: (itemId) => this.steerMailbox.ack(turnId, itemId),
        closeSteerMailbox: () => this.steerMailbox.close(turnId),
        turnAlreadyStarted,
      });
    } catch (error) {
      this.state.status = this.state.abortController.signal.aborted ? "aborted" : "failed";
      this.state.currentTurnId = undefined;
      this.steerMailbox.finish(turnId);
      throw error;
    }
    if (!this.options.projections) {
      this.state.messages = runResult.messages;
      this.state.usage = mergeSessionUsage(this.state.usage, runResult.result.usage);
      this.state.permissionDenials = appendPermissionDenials(
        this.state.permissionDenials,
        runResult.result.permissionDenials,
      );
    }
    this.state.status = runResult.result.type === "aborted" ? "aborted" : runResult.result.type === "error" ? "failed" : "idle";
    this.state.currentTurnId = undefined;
    this.steerMailbox.finish(turnId);
    const sessionEndReason = this.state.status === "aborted" ? "other" : "prompt_input_exit";
    await this.options.lifecycle?.dispatch({
      event: "SessionEnd",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: { reason: sessionEndReason },
      matchQuery: "SessionEnd",
      signal: this.state.abortController.signal,
    });
    yield { type: "session_ended", sessionId: this.state.sessionId, reason: sessionEndReason };
  }

  async dispose(): Promise<void> {
    if (this.state.status === "running") this.abort("session_closed");
    await this.options.turnRunner.dispose?.();
  }

  abort(reason?: string): void {
    this.state.abortController.abort(reason);
    this.state.status = "aborted";
  }

  steer(input: {
    turnId: string;
    itemId: string;
    message: CanonicalMessage;
    allowedReadFiles?: string[];
  }): Promise<AgentSteerResult> {
    if (this.state.status !== "running" || !this.state.currentTurnId) {
      return Promise.resolve({ accepted: false, reason: "no_active_turn" });
    }
    return this.steerMailbox.enqueue(input.turnId, {
      itemId: input.itemId,
      message: input.message,
      allowedReadFiles: input.allowedReadFiles,
    });
  }

  cancelSteer(input: { turnId: string; itemId: string }): Promise<AgentCancelSteerResult> {
    if (this.state.status !== "running" || !this.state.currentTurnId) {
      return Promise.resolve({ cancelled: false, reason: "no_active_turn" });
    }
    return this.steerMailbox.cancel(input.turnId, input.itemId);
  }

  snapshot(): AgentSessionStateShape {
    return this.snapshotFromProjection();
  }

  snapshotForRuntimeReload(): AgentSessionRuntimeReloadSnapshot {
    const runtime = this.options.turnRunner.snapshotForRuntimeReload();
    const durable = this.projectedDurableState();
    return {
      state: cloneSessionStateForRuntimeReload(this.snapshotFromProjection(durable)),
      cwd: runtime.runtimeContext.cwd,
      transcriptPath: runtime.runtimeContext.transcriptPath,
      transcriptWriterState: runtime.transcriptWriterState,
      fileState: this.options.turnRunner.snapshotFileState(),
      metadata: durable?.metadata ?? runtime.metadata,
    };
  }

  async seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    if (this.state.status === "running") {
      const error = Object.assign(new Error("Cannot seed file read state while a turn is active."), {
        code: "SESSION_BUSY",
      });
      throw error;
    }
    return this.options.turnRunner.seedReadState(filePath, mtimeMs);
  }

  async *replay(): AsyncGenerator<AgentEvent, void, unknown> {
    for (const event of this.options.replayEvents ?? []) {
      yield event;
    }
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
  }

  private projectedMessages(): CanonicalMessage[] {
    return this.projectedDurableState()?.conversation.messages ?? this.state.messages;
  }

  private snapshotFromProjection(
    durable = this.projectedDurableState(),
  ): AgentSessionStateShape {
    const snapshot = snapshotAgentSessionState(this.state);
    if (!durable) return snapshot;
    snapshot.messages = durable.conversation.messages;
    snapshot.usage = { ...durable.turnSummary.usage };
    snapshot.permissionDenials = durable.turnSummary.permissionDenials.map((denial) => ({ ...denial }));
    return snapshot;
  }

  private projectedDurableState(): {
    conversation: AgentConversationProjectionResult;
    turnSummary: AgentTurnSummaryProjectionResult;
    metadata: SessionMetadataValue;
  } | undefined {
    if (!this.options.projections) return undefined;
    const snapshot = this.options.projections.snapshot([
      AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation,
      AGENT_TRANSCRIPT_PROJECTION_NAMES.turnSummary,
      AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
    ]);
    return {
      conversation: requireSessionProjectionValue<AgentConversationProjectionResult>(
        snapshot,
        AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation,
      ),
      turnSummary: requireSessionProjectionValue<AgentTurnSummaryProjectionResult>(
        snapshot,
        AGENT_TRANSCRIPT_PROJECTION_NAMES.turnSummary,
      ),
      metadata: requireSessionProjectionValue<SessionMetadataValue>(
        snapshot,
        AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
      ),
    };
  }
}

export function createAgentSessionStateFromReplay(
  sessionId: string,
  replay: AgentTranscriptReplayResult,
): AgentSessionStateShape {
  return {
    ...createInitialAgentSessionState(sessionId),
    messages: replay.messages,
    usage: replay.usage,
    permissionDenials: replay.permissionDenials,
  };
}
