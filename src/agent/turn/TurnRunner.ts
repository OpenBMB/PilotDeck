import { agentError, normalizeAgentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentModelOverride } from "../protocol/input.js";
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
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import type { SessionTitleGenerator } from "../../session/title/SessionTitleGenerator.js";
import type { SessionTitlePort } from "../../session/title/SessionTitlePort.js";
import type { PromptSuggestionGenerator } from "../../session/prompt/PromptSuggestionGenerator.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import { FileArtifactCollector, type FileArtifact } from "../../session/artifacts/index.js";
import type { AgentSteerMessage } from "../session/SteerMailbox.js";
import { AgentSessionEventRecorder } from "../session/AgentSessionEventRecorder.js";
import { isAgentLoopResultUnknownError } from "../modules/transport/operationLedger.js";

export type TurnRunnerOptions = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  input: AgentInput;
  /** Host-owned execution identity forwarded unchanged to the loop provider. */
  execution?: Pick<import("../modules/protocol.js").AgentExecutionContext, "runId" | "operationId" | "idempotencyKey" | "operationDeadline">;
  maxTurns?: number;
  /** Gateway-owned USD ceiling for this submitted turn. */
  maxBudgetUsd?: number;
  /** Gateway-owned USD ceiling shared by every turn in an SDK session. */
  taskBudgetUsd?: number;
  /** Amount already charged to `taskBudgetUsd` before this turn. */
  initialTaskBudgetSpentUsd?: number;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  canElicit?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  abortSignal?: AbortSignal;
  /** Synthetic messages appended after user input; stored with metadata.synthetic flag. */
  syntheticMessages?: CanonicalMessage[];
  modelOverride?: AgentModelOverride;
  modelSelection?: NonNullable<SessionMetadataValue["modelSelection"]>;
  openSteerMailbox?: () => void;
  drainSteerMessages?: () => AgentSteerMessage[];
  drainOrCloseSteerMailbox?: () => { messages: AgentSteerMessage[]; closed: boolean };
  claimSteerMessage?: (itemId: string) => void | Promise<void>;
  ackSteerMessage?: (itemId: string) => void;
  closeSteerMailbox?: () => AgentSteerMessage[] | Promise<AgentSteerMessage[]>;
  /** @internal The queued-turn path committed turn_started before session hooks. */
  turnAlreadyStarted?: boolean;
};

export type TurnRunnerResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type TurnRunnerRuntimeContext = {
  cwd: string;
  transcriptPath: string;
  /** Disable Agent-generated file artifact collection for non-project chats. */
  collectFileArtifacts?: boolean;
};

export type TurnRunnerRuntimeReloadSnapshot = {
  runtimeContext: TurnRunnerRuntimeContext;
  transcriptWriterState?: AgentTranscriptWriterState;
  metadata?: SessionMetadataValue;
};

export type AgentLoopRunner = Pick<AgentLoop, "run" | "snapshotFileState"> &
  Partial<Pick<AgentLoop, "seedReadState">>;

export type TurnRunnerDependencies = {
  metadataStore?: SessionMetadataStore;
  /** Preferred DSH-style provider seam for title generation. */
  sessionTitleProvider?: SessionTitlePort;
  /** @deprecated Use sessionTitleProvider. */
  sessionTitleGenerator?: SessionTitleGenerator;
  /** Optional Gateway-owned generator for SDK promptSuggestions. */
  promptSuggestionGenerator?: PromptSuggestionGenerator;
  autoGenerateSessionTitle?: boolean;
  eventRecorder?: AgentSessionEventRecorder;
};

type PendingSessionTitle = {
  controller: AbortController;
  cleanup: () => void;
  completed: boolean;
  title: string | null;
  messageSequences: readonly number[];
  /** Settles when the title generation finishes (success, failure, or timeout). */
  promise: Promise<void>;
};

const SESSION_LISTING_PROMPT_MAX_CHARS = 1_200;

export class TurnRunner {
  private disposed = false;
  private pendingSessionTitle: PendingSessionTitle | undefined;
  readonly sessionEventRecorder: AgentSessionEventRecorder;

  constructor(
    private readonly loop: AgentLoopRunner,
    private readonly transcript: AgentTranscriptWriter,
    private readonly inputProcessor = new TurnInputProcessor(),
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle?: LifecycleRuntime,
    private readonly runtimeContext: TurnRunnerRuntimeContext = {
      cwd: process.cwd(),
      transcriptPath: "",
    },
    private readonly turnDependencies: TurnRunnerDependencies = {},
  ) {
    this.sessionEventRecorder = turnDependencies.eventRecorder ?? new AgentSessionEventRecorder(transcript);
  }

  /**
   * Appends a Gateway-owned status through this turn runner's existing
   * transcript writer. A live session must never be restored into a second
   * writer just to record a status event.
   */
  async recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: AgentStatusMessageInput,
  ): Promise<boolean> {
    if (!this.transcript.recordAgentStatusMessage) return false;
    await this.transcript.recordAgentStatusMessage(sessionId, turnId, status);
    return true;
  }

  async *run(options: TurnRunnerOptions): AsyncGenerator<AgentEvent, TurnRunnerResult, unknown> {
    if (options.turnAlreadyStarted !== true) {
      await this.sessionEventRecorder.startTurn(options.sessionId, options.turnId);
    }
    yield { type: "turn_started", sessionId: options.sessionId, turnId: options.turnId };
    const loopAbortController = new AbortController();
    const unlinkLoopAbort = linkAbortSignal(options.abortSignal, loopAbortController);
    let artifactCollector: FileArtifactCollector | undefined;
    try {
      const unacknowledgedSteers = new Map<string, AgentSteerMessage>();
      const trackDrainedSteers = (steers: AgentSteerMessage[]): AgentSteerMessage[] => {
        for (const steer of steers) unacknowledgedSteers.set(steer.itemId, steer);
        return steers;
      };
      const closeSteerMailbox = async (): Promise<AgentEvent[]> => {
        const unapplied = new Map(unacknowledgedSteers);
        for (const steer of await options.closeSteerMailbox?.() ?? []) {
          unapplied.set(steer.itemId, steer);
        }
        unacknowledgedSteers.clear();
        return [...unapplied.values()].map((steer) => ({
          type: "steer_unapplied" as const,
          sessionId: options.sessionId,
          turnId: options.turnId,
          itemId: steer.itemId,
          reason: "turn_ended" as const,
        }));
      };
      let artifactsFinished = false;
      const finishArtifacts = async (result: AgentTurnResult): Promise<FileArtifact[]> => {
        if (!artifactCollector || artifactsFinished) return [];
        artifactsFinished = true;
        const artifacts = await artifactCollector.finish(
          result.type === "success" ? "complete" : "incomplete",
        ).catch(() => []);
        if (artifacts.length > 0) {
          await Promise.resolve(
            this.transcript.recordFileArtifacts?.(
              options.sessionId,
              options.turnId,
              artifacts,
            ),
          ).catch(() => {});
        }
        return artifacts;
      };
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
        await this.recordErrorResult(options, result);
        const status = await this.recordTurnFailureStatus(options, agentTranscriptError);
        yield this.toAgentStatusEvent(options, status);
        yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: agentTranscriptError };
        yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
        return { result, messages: options.messages };
      }

      const acceptedInputSequence = this.transcript.snapshotState?.().sequence;

      await this.persistListingPromptMetadata(options, accepted.messages);
      yield { type: "input_accepted", sessionId: options.sessionId, turnId: options.turnId, messages: accepted.messages };

      // Acknowledge durable input before scanning the workspace. The baseline
      // still completes before hooks/model/tools can mutate any files.
      artifactCollector = this.runtimeContext.collectFileArtifacts === false
        ? undefined
        : await FileArtifactCollector.start({
            cwd: this.runtimeContext.cwd,
            allowedInputPaths: options.allowedReadFiles,
            now: this.now,
          }).catch(() => undefined);

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
        const error = agentError("agent_unsupported_feature", "UserPromptSubmit hook blocked model execution.");
        const result = this.createErrorResult(
          options,
          error,
        );
        await this.recordErrorResult(options, result);
        const artifacts = await finishArtifacts(result);
        if (artifacts.length > 0) {
          yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
        }
        const status = await this.recordTurnFailureStatus(options, error);
        yield this.toAgentStatusEvent(options, status);
        await this.finalizeSessionMetadata(options);
        yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error };
        yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
        return { result, messages };
      }
      messages.push(...(userPromptHooks?.messages ?? []));

      const sessionTitle = this.maybeGenerateSessionTitle(
        options,
        accepted.messages,
        acceptedInputSequence === undefined ? [] : [acceptedInputSequence],
      );

      if (!accepted.shouldCallModel) {
        const error = agentError("agent_unsupported_feature", "Input was accepted but model execution was not requested.");
        const result = this.createErrorResult(
          options,
          error,
        );
        await this.recordErrorResult(options, result);
        const artifacts = await finishArtifacts(result);
        if (artifacts.length > 0) {
          yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
        }
        const status = await this.recordTurnFailureStatus(options, error);
        yield this.toAgentStatusEvent(options, status);
        await this.finalizeSessionMetadata(options, sessionTitle);
        yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error };
        yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
        return { result, messages };
      }

      options.openSteerMailbox?.();
      try {
        let hasRecordedVisibleFailureStatus = false;
        const generator = this.loop.run({
          sessionId: options.sessionId,
          turnId: options.turnId,
          messages,
          execution: options.execution,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          taskBudgetUsd: options.taskBudgetUsd,
          initialTaskBudgetSpentUsd: options.initialTaskBudgetSpentUsd,
          runMode: options.runMode,
          permissionMode: options.permissionMode,
          allowedReadFiles: options.allowedReadFiles,
          basePermissionMode: options.basePermissionMode,
          allowPlanModeTools: options.allowPlanModeTools,
          canPrompt: options.canPrompt,
          canElicit: options.canElicit,
          permissionRules: options.permissionRules,
          modelOverride: options.modelOverride,
          abortSignal: loopAbortController.signal,
          drainSteerMessages: options.drainSteerMessages
            ? () => trackDrainedSteers(options.drainSteerMessages?.() ?? [])
            : undefined,
          drainOrCloseSteerMailbox: options.drainOrCloseSteerMailbox
            ? () => {
                const drained = options.drainOrCloseSteerMailbox?.() ?? { messages: [], closed: true };
                return { ...drained, messages: trackDrainedSteers(drained.messages) };
              }
            : undefined,
          onSteerApplied: (itemId) => {
            const applied = unacknowledgedSteers.get(itemId);
            if (applied) messages.push(applied.message);
            unacknowledgedSteers.delete(itemId);
            options.ackSteerMessage?.(itemId);
          },
          onDurableMessage: async (msg) => {
            const itemId = msg.metadata?.queueItemId;
            if (itemId) await options.claimSteerMessage?.(itemId);
            await this.transcript.recordDurableMessage(options.sessionId, options.turnId, msg);
          },
          onAgentStatusMessage: async (status) => {
            if (isVisibleFailureStatus(status)) {
              hasRecordedVisibleFailureStatus = true;
            }
            await this.transcript.recordAgentStatusMessage?.(options.sessionId, options.turnId, status);
          },
          onCompactPersisted: async ({ boundary, messages: compactMessages }) => {
            try {
              if (
                boundary.kind === "compact" &&
                "subtype" in boundary &&
                boundary.subtype === "compact_boundary" &&
                this.transcript.recordCompactionReplacement
              ) {
                await this.transcript.recordCompactionReplacement(
                  options.sessionId,
                  options.turnId,
                  boundary,
                  compactMessages,
                );
              } else if (
                boundary.kind === "compact" &&
                "subtype" in boundary &&
                boundary.subtype === "compact_boundary" &&
                this.transcript.recordControlBoundary
              ) {
                await this.transcript.recordControlBoundary(options.sessionId, options.turnId, {
                  ...boundary,
                  snapshot: { version: 1, messages: compactMessages.map((message) => structuredClone(message)) },
                });
              } else {
                throw new Error("Transcript writer does not support atomic compaction replacement.");
              }
              await this.sessionEventRecorder.commitDeferredCompaction(options.sessionId, options.turnId);
            } catch (error) {
              // AgentLoop deliberately treats this callback as best-effort.
              // Close the durable bracket here and abort the outer run so a
              // compacted-but-unpersisted surface is never sent to the model.
              await this.sessionEventRecorder
                .failDeferredCompaction(options.sessionId, options.turnId, error)
                .catch(() => {});
              loopAbortController.abort("compaction_persistence_failed");
            }
          },
        });
        let runResult: TurnRunnerResult | undefined;
        let turnCompletedEvent: Extract<AgentEvent, { type: "turn_completed" }> | undefined;
        try {
          while (true) {
            const next = await generator.next();
            if (next.done) {
              runResult = next.value;
              break;
            }
            const event = next.value;
            if (event.type === "tool_result") {
              artifactCollector?.observeToolResult(event.result);
            }
            if (event.type === "file_artifacts") {
              continue;
            }
            if (event.type === "turn_completed") {
              turnCompletedEvent = event;
              continue;
            }
            if (event.type === "turn_failed" && !hasRecordedVisibleFailureStatus) {
              const status = await this.recordTurnFailureStatus(options, event.error);
              hasRecordedVisibleFailureStatus = true;
              yield this.toAgentStatusEvent(options, status);
            }
            yield event;
          }
        } finally {
          await generator.return(undefined as never);
        }

        const unappliedSteers = await closeSteerMailbox();
        const artifacts = await finishArtifacts(runResult.result);
        if (artifacts.length > 0) {
          yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
        }
        for (const event of unappliedSteers) yield event;
        await this.sessionEventRecorder.completeTurn(runResult.result);
        const suggestion = await this.generatePromptSuggestion(options, prompt, runResult.result);
        if (suggestion) {
          yield { type: "prompt_suggestion", sessionId: options.sessionId, turnId: options.turnId, suggestion };
        }
        await this.finalizeSessionMetadata(options, sessionTitle);
        if (turnCompletedEvent) yield turnCompletedEvent;
        return runResult;
      } catch (error) {
        const unappliedSteers = await closeSteerMailbox();
        if (isTimedOutUnknownOperation(error, options)) {
          throw error;
        }
        const normalized = normalizeAgentError(error);
        const result = this.createErrorResult(options, normalized);
        const artifacts = await finishArtifacts(result);
        if (artifacts.length > 0) {
          yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
        }
        await this.sessionEventRecorder.completeTurn(result);
        const status = await this.recordTurnFailureStatus(options, normalized);
        yield this.toAgentStatusEvent(options, status);
        await this.finalizeSessionMetadata(options, sessionTitle);
        yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: normalized };
        for (const event of unappliedSteers) yield event;
        yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
        return { result, messages };
      }
    } finally {
      unlinkLoopAbort();
      await options.closeSteerMailbox?.();
      artifactCollector?.dispose();
    }
  }

  snapshotForRuntimeReload(): TurnRunnerRuntimeReloadSnapshot {
    return {
      runtimeContext: { ...this.runtimeContext },
      transcriptWriterState: this.transcript.snapshotState?.(),
      metadata: this.turnDependencies.metadataStore?.getSnapshot(),
    };
  }

  snapshotFileState(): AgentLoopSeedState {
    return this.loop.snapshotFileState();
  }

  async seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    if (!this.loop.seedReadState) {
      throw Object.assign(new Error("seedReadState is unavailable for this AgentLoop runner."), {
        code: "CAPABILITY_UNAVAILABLE",
      });
    }
    return this.loop.seedReadState(filePath, mtimeMs);
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
    await this.sessionEventRecorder.completeTurn(result);
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
      kind: status.kind,
      text: status.text,
      detail: status.detail,
    };
  }

  /** Invalidate background work before the session transcript is removed/replaced. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingSessionTitle?.controller.abort("session_closed");
    this.pendingSessionTitle?.cleanup();
    // A provider may ignore cancellation. Do not wait for its network request;
    // the completion guard below prevents it from ever saving a late title.
    await this.transcript.close?.();
  }

  private maybeGenerateSessionTitle(
    options: TurnRunnerOptions,
    acceptedMessages: CanonicalMessage[],
    messageSequences: readonly number[] = [],
  ): PendingSessionTitle | undefined {
    if (this.disposed || this.turnDependencies.autoGenerateSessionTitle !== true) {
      return undefined;
    }
    const metadataStore = this.turnDependencies.metadataStore;
    const titleProvider = this.turnDependencies.sessionTitleProvider;
    const generateTitle = titleProvider
      ? titleProvider.generate.bind(titleProvider)
      : this.turnDependencies.sessionTitleGenerator;
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
    // Provenance identifies the newly committed accepted input, but title
    // generation needs the full human task context when a prior attempt
    // returned no title. Keep those concerns separate.
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
      messageSequences: [...messageSequences],
      promise: generateTitle({
        text,
        sessionId: options.sessionId,
        turnId: options.turnId,
        messageSequences: [...messageSequences],
        signal: controller.signal,
      })
        .then(async (title) => {
          if (this.disposed || controller.signal.aborted) return;
          pending.title = title;
          if (title) {
            const snap = metadataStore.getSnapshot();
            if (!snap.title && !snap.aiTitle) {
              await metadataStore.saveAiTitle(title, options.turnId, {
                titleProviderId: this.turnDependencies.sessionTitleProvider?.providerId,
                titleModel: this.turnDependencies.sessionTitleProvider?.modelProvenance,
                titleMessageSequences: [...messageSequences],
              });
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
    await metadataStore.saveAiTitle(pending.title, options.turnId, {
      titleProviderId: this.turnDependencies.sessionTitleProvider?.providerId,
      titleModel: this.turnDependencies.sessionTitleProvider?.modelProvenance,
      titleMessageSequences: [...pending.messageSequences],
    });
  }

  private async finalizeSessionMetadata(
    options: TurnRunnerOptions,
    pending?: PendingSessionTitle,
  ): Promise<void> {
    // Title completion saves its own metadata. It must not hold the session
    // slot after the reply finishes; later turns can continue while it runs.
    pending?.cleanup();
    await this.turnDependencies.metadataStore?.reappendTail(options.turnId).catch(() => {});
  }

  private async generatePromptSuggestion(
    options: TurnRunnerOptions,
    userPrompt: string,
    result: AgentTurnResult,
  ): Promise<string | null> {
    const generate = this.turnDependencies.promptSuggestionGenerator;
    if (!generate || result.type !== "success" || options.abortSignal?.aborted) return null;
    const assistantResponse = result.finalMessage?.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (!assistantResponse) return null;
    try {
      return await generate({
        userPrompt,
        assistantResponse,
        sessionId: options.sessionId,
        turnId: options.turnId,
        signal: options.abortSignal ?? new AbortController().signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.debug(`[prompt-suggestion] generation skipped (provider_error): ${message.slice(0, 200)}`);
      return null;
    }
  }

  private async persistListingPromptMetadata(
    options: TurnRunnerOptions,
    acceptedMessages: CanonicalMessage[],
  ): Promise<void> {
    const metadataStore = this.turnDependencies.metadataStore;
    if (!metadataStore) return;

    const snapshot = metadataStore.getSnapshot();
    const prompt = allHumanText(acceptedMessages);
    if (!prompt && !options.modelSelection) return;

    const boundedPrompt = prompt?.slice(0, SESSION_LISTING_PROMPT_MAX_CHARS);
    await metadataStore.record(options.turnId, {
      ...(boundedPrompt ? {
        ...(snapshot.firstPrompt ? {} : { firstPrompt: boundedPrompt }),
        lastPrompt: boundedPrompt,
      } : {}),
      ...(options.modelSelection ? { modelSelection: { ...options.modelSelection } } : {}),
      updatedAt: this.now().toISOString(),
    }).catch(() => {});
  }
}

function isTimedOutUnknownOperation(error: unknown, options: TurnRunnerOptions): boolean {
  if (!isAgentLoopResultUnknownError(error) || options.abortSignal?.aborted !== true) return false;
  const runId = options.execution?.runId;
  return typeof runId === "string" && options.abortSignal.reason === `timeout:${runId}`;
}

function isVisibleFailureStatus(status: AgentStatusMessageInput): boolean {
  return status.kind === "error" && status.event !== "turn_failed";
}

function acceptedInputMetadata(options: TurnRunnerOptions): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  // Save alongside input so a crash before the metadata snapshot cannot lose the choice.
  if (options.modelSelection) metadata.modelSelection = { ...options.modelSelection };
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
