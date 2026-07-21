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
import type { AgentStatusMessageInput, AgentTranscriptWriterState } from "../../session/transcript/TranscriptWriter.js";
import type { SessionMetadataStore } from "../../session/metadata/SessionMetadataStore.js";
import type { SessionTitleGenerator } from "../../session/title/SessionTitleGenerator.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";

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
  /** Synthetic messages appended after user input; stored with metadata.synthetic flag. */
  syntheticMessages?: CanonicalMessage[];
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

export type TurnRunnerDependencies = {
  metadataStore?: SessionMetadataStore;
  sessionTitleGenerator?: SessionTitleGenerator;
  autoGenerateSessionTitle?: boolean;
};

type PendingSessionTitle = {
  controller: AbortController;
  cleanup: () => void;
  completed: boolean;
  title: string | null;
  /** Settles when the title generation finishes (success, failure, or timeout). */
  promise: Promise<void>;
};

export class TurnRunner {
  private pendingSessionTitle: PendingSessionTitle | undefined;

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
    private readonly turnDependencies: TurnRunnerDependencies = {},
  ) {}

  async *run(options: TurnRunnerOptions): AsyncGenerator<AgentEvent, TurnRunnerResult, unknown> {
    yield { type: "turn_started", sessionId: options.sessionId, turnId: options.turnId };
    const accepted = this.inputProcessor.accept(options.input);
    const allAcceptedMessages = [...accepted.messages, ...(options.syntheticMessages ?? [])];
    const messages = [...options.messages, ...allAcceptedMessages];

    try {
      await this.transcript.recordAcceptedInput(
        options.sessionId,
        options.turnId,
        allAcceptedMessages,
        acceptedInputMetadata(options),
      );
    } catch (error) {
      const agentTranscriptError = agentError("agent_transcript_error", "Failed to record accepted input.", error);
      const result = this.createErrorResult(options, agentTranscriptError);
      const status = await this.recordTurnFailureStatus(options, agentTranscriptError);
      yield this.toAgentStatusEvent(options, status);
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
      payload: { prompt, internal: options.input.isMeta === true, turnId: options.turnId },
      matchQuery: "UserPromptSubmit",
      signal: options.abortSignal,
    });
    yield { type: "user_prompt_submitted", sessionId: options.sessionId, turnId: options.turnId, prompt };
    if (userPromptHooks?.effects.some((effect) => effect.type === "block")) {
      const error = agentError("agent_unsupported_feature", "UserPromptSubmit hook blocked model execution.");
      const result = this.createErrorResult(
        options,
        error,
      );
      await this.recordErrorResult(options, result);
      const status = await this.recordTurnFailureStatus(options, error);
      yield this.toAgentStatusEvent(options, status);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }
    messages.push(...(userPromptHooks?.messages ?? []));

    const sessionTitle = this.maybeGenerateSessionTitle(options, accepted.messages);

    if (!accepted.shouldCallModel) {
      const error = agentError("agent_unsupported_feature", "Input was accepted but model execution was not requested.");
      const result = this.createErrorResult(
        options,
        error,
      );
      await this.recordErrorResult(options, result);
      const status = await this.recordTurnFailureStatus(options, error);
      yield this.toAgentStatusEvent(options, status);
      await this.flushReadySessionTitle(options, sessionTitle);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }

    try {
      let hasRecordedVisibleFailureStatus = false;
      const generator = this.loop.run({
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
        onAgentStatusMessage: async (status) => {
          if (isVisibleFailureStatus(status)) {
            hasRecordedVisibleFailureStatus = true;
          }
          await this.transcript.recordAgentStatusMessage?.(options.sessionId, options.turnId, status);
        },
      });
      let runResult: TurnRunnerResult | undefined;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          runResult = next.value;
          break;
        }
        const event = next.value;
        if (event.type === "turn_failed" && !hasRecordedVisibleFailureStatus) {
          const status = await this.recordTurnFailureStatus(options, event.error);
          hasRecordedVisibleFailureStatus = true;
          yield this.toAgentStatusEvent(options, status);
        }
        yield event;
      }

      await this.transcript.recordTurnResult(options.sessionId, options.turnId, runResult.result);
      await this.flushReadySessionTitle(options, sessionTitle);
      return runResult;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      const result = this.createErrorResult(options, normalized);
      await Promise.resolve(this.transcript.recordTurnResult(options.sessionId, options.turnId, result)).catch(() => {});
      const status = await this.recordTurnFailureStatus(options, normalized);
      yield this.toAgentStatusEvent(options, status);
      await this.flushReadySessionTitle(options, sessionTitle);
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

  private async recordErrorResult(_options: TurnRunnerOptions, result: AgentTurnResult): Promise<void> {
    await Promise.resolve(this.transcript.recordTurnResult(result.sessionId, result.turnId, result)).catch(() => {});
  }

  private async recordTurnFailureStatus(
    options: TurnRunnerOptions,
    error: ReturnType<typeof agentError>,
  ): Promise<AgentStatusMessageInput> {
    const status = this.createTurnFailureStatus(error);
    await Promise.resolve(this.transcript.recordAgentStatusMessage?.(options.sessionId, options.turnId, status)).catch(() => {});
    return status;
  }

  private createTurnFailureStatus(error: ReturnType<typeof agentError>): AgentStatusMessageInput {
    return {
      event: "turn_failed",
      kind: "error",
      text: error.message,
      detail: createVisibleErrorStatusDetail({
        message: error.message,
        code: error.code,
        userHint: error.userHint ?? "Retry the turn; if it repeats, check the gateway logs or adjust the request.",
        scope: "turn",
        source: "agent",
      }),
    };
  }

  private toAgentStatusEvent(options: TurnRunnerOptions, status: AgentStatusMessageInput): AgentEvent {
    return {
      type: "agent_status",
      sessionId: options.sessionId,
      turnId: options.turnId,
      event: status.event,
      detail: status.detail,
    };
  }

  private maybeGenerateSessionTitle(
    options: TurnRunnerOptions,
    acceptedMessages: CanonicalMessage[],
  ): PendingSessionTitle | undefined {
    if (this.turnDependencies.autoGenerateSessionTitle !== true) {
      return undefined;
    }
    const metadataStore = this.turnDependencies.metadataStore;
    const generateTitle = this.turnDependencies.sessionTitleGenerator;
    if (!metadataStore || !generateTitle) {
      return undefined;
    }
    const snapshot = metadataStore.getSnapshot();
    if (snapshot.title || snapshot.aiTitle) {
      return undefined;
    }
    if (this.pendingSessionTitle && !this.pendingSessionTitle.completed) {
      return this.pendingSessionTitle;
    }
    const text = allHumanText([...options.messages, ...acceptedMessages]);
    if (!text) {
      return undefined;
    }

    const controller = new AbortController();
    const cleanup = linkAbortSignal(options.abortSignal, controller);
    const pending: PendingSessionTitle = {
      controller,
      cleanup,
      completed: false,
      title: null,
      promise: generateTitle({
        text,
        sessionId: options.sessionId,
        turnId: options.turnId,
        signal: controller.signal,
      })
        .then(async (title) => {
          pending.title = title;
          if (title) {
            const snap = metadataStore.getSnapshot();
            if (!snap.title && !snap.aiTitle) {
              await metadataStore.saveAiTitle(title, options.turnId);
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          pending.completed = true;
          cleanup();
        }),
    };
    this.pendingSessionTitle = pending;
    return pending;
  }

  private async flushReadySessionTitle(
    options: TurnRunnerOptions,
    pending: PendingSessionTitle | undefined,
  ): Promise<void> {
    if (!pending) {
      return;
    }
    if (!pending.completed) {
      // The title generation has its own timeout (SESSION_TITLE_TIMEOUT_MS).
      // Wait for it to settle instead of discarding immediately.
      await pending.promise;
    }
    if (!pending.title) {
      return;
    }
    const metadataStore = this.turnDependencies.metadataStore;
    if (!metadataStore) {
      return;
    }
    const latest = metadataStore.getSnapshot();
    if (latest.title || latest.aiTitle) {
      return;
    }
    await metadataStore.saveAiTitle(pending.title, options.turnId);
  }
}

function isVisibleFailureStatus(status: AgentStatusMessageInput): boolean {
  return status.kind === "error" && status.event !== "turn_failed";
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

function allHumanText(messages: CanonicalMessage[]): string | null {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.metadata?.synthetic) {
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!source) {
    return () => {};
  }
  if (source.aborted) {
    controller.abort(source.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}
