import { agentError, normalizeAgentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput } from "../protocol/input.js";
import type { AgentRunMode } from "../protocol/input.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentLoop, AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { TurnInputProcessor } from "./TurnInputProcessor.js";
import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";
import type { AgentTranscriptWriterState } from "../../session/transcript/TranscriptWriter.js";

export type TurnRunnerOptions = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  input: AgentInput;
  maxTurns?: number;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  abortSignal?: AbortSignal;
};

export type TurnRunnerResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type TurnRunnerRuntimeContext = {
  cwd: string;
  transcriptPath: string;
};

export type TurnRunnerRuntimeReloadSnapshot = {
  runtimeContext: TurnRunnerRuntimeContext;
  transcriptWriterState?: AgentTranscriptWriterState;
};

export class TurnRunner {
  constructor(
    private readonly loop: AgentLoop,
    private readonly transcript: AgentTranscriptWriter,
    private readonly inputProcessor = new TurnInputProcessor(),
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle?: LifecycleRuntime,
    private readonly runtimeContext: TurnRunnerRuntimeContext = {
      cwd: process.cwd(),
      transcriptPath: "",
    },
  ) {}

  async *run(options: TurnRunnerOptions): AsyncGenerator<AgentEvent, TurnRunnerResult, unknown> {
    yield { type: "turn_started", sessionId: options.sessionId, turnId: options.turnId };
    const accepted = this.inputProcessor.accept(options.input);
    const messages = [...options.messages, ...accepted.messages];

    try {
      await this.transcript.recordAcceptedInput(
        options.sessionId,
        options.turnId,
        accepted.messages,
        acceptedInputMetadata(options),
      );
    } catch (error) {
      const agentTranscriptError = agentError("agent_transcript_error", "Failed to record accepted input.", error);
      const result = this.createErrorResult(options, agentTranscriptError);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: agentTranscriptError };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages: options.messages };
    }

    yield { type: "input_accepted", sessionId: options.sessionId, turnId: options.turnId, messages: accepted.messages };

    const prompt = inputToPromptText(options.input);
    const userPromptHooks = await this.lifecycle?.dispatch({
      event: "UserPromptSubmit",
      baseInput: {
        sessionId: options.sessionId,
        transcriptPath: this.runtimeContext.transcriptPath,
        cwd: this.runtimeContext.cwd,
      },
      payload: { prompt },
      matchQuery: "UserPromptSubmit",
      signal: options.abortSignal,
    });
    yield { type: "user_prompt_submitted", sessionId: options.sessionId, turnId: options.turnId, prompt };
    if (userPromptHooks?.effects.some((effect) => effect.type === "block")) {
      const result = this.createErrorResult(
        options,
        agentError("agent_unsupported_feature", "UserPromptSubmit hook blocked model execution."),
      );
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }
    messages.push(...(userPromptHooks?.messages ?? []));

    if (!accepted.shouldCallModel) {
      const result = this.createErrorResult(
        options,
        agentError("agent_unsupported_feature", "Input was accepted but model execution was not requested."),
      );
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }

    try {
      const runResult = yield* this.loop.run({
        sessionId: options.sessionId,
        turnId: options.turnId,
        messages,
        maxTurns: options.maxTurns,
        runMode: options.runMode,
        permissionMode: options.permissionMode,
        allowedReadFiles: options.allowedReadFiles,
        basePermissionMode: options.basePermissionMode,
        allowPlanModeTools: options.allowPlanModeTools,
        canPrompt: options.canPrompt,
        permissionRules: options.permissionRules,
        abortSignal: options.abortSignal,
        onDurableMessage: (msg) => this.transcript.recordDurableMessage(options.sessionId, options.turnId, msg),
      });

      await this.transcript.recordTurnResult(options.sessionId, options.turnId, runResult.result);
      return runResult;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      const result = this.createErrorResult(options, normalized);
      await Promise.resolve(this.transcript.recordTurnResult(options.sessionId, options.turnId, result)).catch(() => {});
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: normalized };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }
  }

  snapshotForRuntimeReload(): TurnRunnerRuntimeReloadSnapshot {
    return {
      runtimeContext: { ...this.runtimeContext },
      transcriptWriterState: this.transcript.snapshotState?.(),
    };
  }

  snapshotFileState(): AgentLoopSeedState {
    return this.loop.snapshotFileState();
  }

  private createErrorResult(options: TurnRunnerOptions, error: ReturnType<typeof agentError>): AgentTurnResult {
    const timestamp = this.now().toISOString();
    return {
      type: "error",
      sessionId: options.sessionId,
      turnId: options.turnId,
      stopReason: error.code === "agent_aborted" ? "aborted_streaming" : "model_error",
      usage: emptyUsage(),
      permissionDenials: [],
      turns: 0,
      startedAt: timestamp,
      completedAt: timestamp,
      errors: [error],
    };
  }
}

function acceptedInputMetadata(options: TurnRunnerOptions): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (options.permissionMode) {
    metadata.permissionMode = options.permissionMode;
  }
  if (options.runMode) {
    metadata.runMode = options.runMode;
  }
  if (options.basePermissionMode) {
    metadata.basePermissionMode = options.basePermissionMode;
  }
  if (options.allowPlanModeTools !== undefined) {
    metadata.allowPlanModeTools = options.allowPlanModeTools;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function emptyUsage(): CanonicalUsage {
  return {};
}

function inputToPromptText(input: AgentInput): string {
  if (input.type === "text") {
    return input.text;
  }
  return input.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
