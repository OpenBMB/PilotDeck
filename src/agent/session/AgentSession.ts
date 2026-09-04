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
import type { AgentTranscriptWriterState } from "../../session/transcript/TranscriptWriter.js";
import type { AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import type { CanonicalMessage } from "../../model/index.js";
import {
  SteerMailbox,
  type AgentCancelSteerResult,
  type AgentSteerResult,
} from "./SteerMailbox.js";

export type AgentSessionOptions = {
  sessionId: string;
  turnRunner: TurnRunner;
  cwd?: string;
  transcriptPath?: string;
  uuid?: () => string;
  initialState?: AgentSessionStateShape;
  replayEvents?: AgentEvent[];
  lifecycle?: LifecycleRuntime;
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
  private readonly steerMailbox = new SteerMailbox();

  constructor(private readonly options: AgentSessionOptions) {
    this.state = options.initialState ?? createInitialAgentSessionState(options.sessionId);
  }

  async *submit(input: AgentInput, submitOptions: AgentSubmitOptions = {}): AsyncGenerator<AgentEvent, void, unknown> {
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

    const runResult = yield* this.options.turnRunner.run({
      sessionId: this.state.sessionId,
      turnId,
      messages: this.state.messages,
      input,
      maxTurns: submitOptions.maxTurns,
      thinking: submitOptions.thinking,
      runMode: submitOptions.runMode,
      permissionMode: submitOptions.permissionMode,
      allowedReadFiles: submitOptions.allowedReadFiles,
      basePermissionMode: submitOptions.basePermissionMode,
      allowPlanModeTools: submitOptions.allowPlanModeTools,
      canPrompt: submitOptions.canPrompt,
      permissionRules: submitOptions.permissionRules,
      syntheticMessages: submitOptions.syntheticMessages,
      modelOverride: submitOptions.modelOverride,
      abortSignal: this.state.abortController.signal,
      openSteerMailbox: () => this.steerMailbox.start(turnId),
      drainSteerMessages: () => this.steerMailbox.drain(turnId),
      drainOrCloseSteerMailbox: () => this.steerMailbox.drainOrClose(turnId),
      closeSteerMailbox: () => this.steerMailbox.close(turnId),
    });

    this.state.messages = runResult.messages;
    this.state.usage = mergeSessionUsage(this.state.usage, runResult.result.usage);
    this.state.permissionDenials = appendPermissionDenials(
      this.state.permissionDenials,
      runResult.result.permissionDenials,
    );
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

  abort(reason?: string): void {
    this.state.abortController.abort(reason);
    this.state.status = "aborted";
  }

  steer(input: {
    turnId: string;
    itemId: string;
    message: CanonicalMessage;
    allowedReadFiles?: string[];
  }): AgentSteerResult {
    if (this.state.status !== "running" || !this.state.currentTurnId) {
      return { accepted: false, reason: "no_active_turn" };
    }
    return this.steerMailbox.enqueue(input.turnId, {
      itemId: input.itemId,
      message: input.message,
      allowedReadFiles: input.allowedReadFiles,
    });
  }

  cancelSteer(input: { turnId: string; itemId: string }): AgentCancelSteerResult {
    if (this.state.status !== "running" || !this.state.currentTurnId) {
      return { cancelled: false, reason: "no_active_turn" };
    }
    return this.steerMailbox.cancel(input.turnId, input.itemId);
  }

  snapshot(): AgentSessionStateShape {
    return snapshotAgentSessionState(this.state);
  }

  snapshotForRuntimeReload(): AgentSessionRuntimeReloadSnapshot {
    const runtime = this.options.turnRunner.snapshotForRuntimeReload();
    return {
      state: cloneSessionStateForRuntimeReload(this.state),
      cwd: runtime.runtimeContext.cwd,
      transcriptPath: runtime.runtimeContext.transcriptPath,
      transcriptWriterState: runtime.transcriptWriterState,
      fileState: this.options.turnRunner.snapshotFileState(),
      metadata: runtime.metadata,
    };
  }

  async *replay(): AsyncGenerator<AgentEvent, void, unknown> {
    for (const event of this.options.replayEvents ?? []) {
      yield event;
    }
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
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
