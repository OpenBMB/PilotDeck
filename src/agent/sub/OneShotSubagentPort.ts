import { randomUUID } from "node:crypto";
import type { PilotDeckReadFileStateMap, PilotDeckSubagentForkApi, PilotDeckWriteSnapshotMap } from "../../tool/index.js";
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from "../../tool/protocol/subagentTimeout.js";
import type { PilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { buildTurnEnvironment } from "../turn/TurnEnvironment.js";
import { SUBAGENT_DEFINITIONS, type SubagentDefinition } from "./builtinSubagentTypes.js";
import { SubAgentSession } from "./SubAgentSession.js";
import type { SidechainTranscriptWriter } from "./SubagentProvider.js";
import type { AgentEvent } from "../protocol/events.js";

export type OneShotSubagentPortOptions = {
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
};

export type OneShotSubagentPortRequest = {
  sessionId: string;
  turnId: string;
  parentReadFileState?: PilotDeckReadFileStateMap;
  parentWriteSnapshots?: PilotDeckWriteSnapshotMap;
  workspaceId?: string;
  storageConfigVersion?: string;
  invocationLogSink?: import("../../storage/invocationStorage.js").ModelInvocationLogSink;
};

/** Stable delegation Definition consumed by AgentLoop's tool runtime context. */
export type OneShotSubagentPort = {
  createForkApi(input: OneShotSubagentPortRequest): PilotDeckSubagentForkApi;
};

type InternalSubagentForkInput = Parameters<PilotDeckSubagentForkApi["fork"]>[0] & {
  suppressAutoObserver?: boolean;
  definitionOverride?: SubagentDefinition;
};

type ObserverOutcome = {
  success: boolean;
  markdown?: string;
  error?: string;
};

const OBSERVER_MAX_ACTIVITY_EVENTS = 64;
const OBSERVER_MAX_TEXT_CHARS = 12_000;

/**
 * Host-owned one-shot subagent consumer.
 *
 * It supplies the `agent` tool's fork contract without making a sidecar own
 * child session state. Named provider selection, child composition, sidechain
 * persistence and run disposal remain inside the native subagent family.
 */
export function createNativeOneShotSubagentPort(
  options: OneShotSubagentPortOptions,
): OneShotSubagentPort {
  return {
    createForkApi: (input) => createNativeForkApi({ ...options, ...input }),
  };
}

function createNativeForkApi(
  options: OneShotSubagentPortOptions & OneShotSubagentPortRequest,
): PilotDeckSubagentForkApi {
  const depth = options.config.subagentDepth ?? 0;
  const maxSubagentDepth = options.config.maxSubagentDepth ?? 1;
  const definitions: Record<string, SubagentDefinition> = options.config.subagentDefinitions ?? SUBAGENT_DEFINITIONS;
  const api: PilotDeckSubagentForkApi = {
    depth,
    maxSubagentDepth,
    listDefinitions: () => Object.values(definitions).map((definition) => ({
      id: definition.id,
      description: definition.description,
    })),
    isAllowedDefinition: (id) => definitions[id] !== undefined,
    isBackgroundDefinition: (id) => definitions[id]?.background === true,
    launchBackground: options.dependencies.backgroundSubagents
      ? async ({ definitionId, directive, subagentId, toolCallId, timeoutMs }) => {
          const definition = definitions[definitionId];
          if (!definition?.background) {
            throw new Error(`Subagent type ${definitionId} is not configured for background execution.`);
          }
          return options.dependencies.backgroundSubagents!.launch({
            sessionId: options.sessionId,
            turnId: options.turnId,
            subagentId,
            subagentType: definition.id,
            run: async (abortSignal) => {
              await api.fork({ definitionId, directive, subagentId, toolCallId, timeoutMs, abortSignal });
            },
          });
        }
      : undefined,
    fork: async (forkInput) => {
      const { definitionId, directive, subagentId, toolCallId, abortSignal, timeoutMs } = forkInput;
      const internalInput = forkInput as InternalSubagentForkInput;
      const definition = internalInput.definitionOverride ?? definitions[definitionId];
      if (!definition) throw new Error(`Unknown subagent type: ${definitionId}`);
      const observerDefinition = !internalInput.suppressAutoObserver && definition.observer
        ? definitions[definition.observer]
        : undefined;
      if (definition.observer && !internalInput.suppressAutoObserver && !observerDefinition) {
        throw new Error(`Observer definition ${definition.observer} for ${definition.id} is not configured.`);
      }
      if (observerDefinition && !options.dependencies.observerSubagents) {
        throw new Error(`Observer definition ${observerDefinition.id} requires a host observer-subagent launcher.`);
      }
      const observerActivity: AgentEvent[] = [];
      const effectiveTimeoutMs = timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
      const abort = composeAbortSignal(abortSignal, effectiveTimeoutMs);
      const subagentSessionId = `${options.config.cwd}::sub::${subagentId}`;
      const transcript = options.dependencies.subagentTranscript;
      let sidechain: SidechainTranscriptWriter | undefined;
      let sidechainDisposed = false;
      let startedRecorded = false;
      let completionAttempted = false;
      let lifecycleStarted = false;
      let lifecycleStopped = false;
      let startedEventEmitted = false;
      let completedEventEmitted = false;
      const disposeSidechain = async (): Promise<void> => {
        if (sidechainDisposed) return;
        sidechainDisposed = true;
        await sidechain?.dispose?.();
      };

      try {
        sidechain = transcript?.subagentTranscriptResolver?.(subagentId, subagentSessionId);
        await transcript?.recordSubagentStarted?.({
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          prompt: directive,
          transcriptRelativePath: sidechain?.transcriptRelativePath ?? "",
          subagentSessionId,
        });
        startedRecorded = true;
        await dispatchSubagentLifecycle(options, abortSignal, "SubagentStart", {
          subagentId,
          subagentType: definition.id,
        });
        lifecycleStarted = true;
        options.dependencies.eventEmitter?.({
          type: "subagent_started",
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          toolCallId,
        });
        startedEventEmitted = true;

        const session = new SubAgentSession({
          definition,
          directive,
          parentConfig: {
            ...options.config,
            subagentDepth: depth + 1,
            isSubagent: true,
          },
          parentDependencies: options.dependencies,
          parentReadFileState: options.parentReadFileState,
          parentWriteSnapshots: options.parentWriteSnapshots,
          parentSessionId: options.sessionId,
          parentTurnId: options.turnId,
          workspaceId: options.workspaceId,
          storageConfigVersion: options.storageConfigVersion,
          invocationLogSink: options.invocationLogSink,
          parentToolCallId: toolCallId,
          subagentSessionId,
          subagentId,
          maxTurns: definition.maxTurns,
          abortSignal: abort.signal,
          ...(observerDefinition
            ? {
                onActivity: (event: AgentEvent) => {
                  if (observerActivity.length < OBSERVER_MAX_ACTIVITY_EVENTS) observerActivity.push(event);
                },
              }
            : {}),
          sidechainTranscript: sidechain,
        });
        const report = await session.run();
        if (abort.timedOut()) {
          throw new Error(`Subagent timed out after ${effectiveTimeoutMs}ms.`);
        }
        if (abortSignal?.aborted) {
          throw new Error("Subagent aborted before completion.");
        }
        // A parent completion must never advertise a child whose selected
        // persistence backend has not finished its durable teardown.
        await disposeSidechain();
        completionAttempted = true;
        await transcript?.recordSubagentCompleted?.({
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          summary: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          errored: false,
        });
        await dispatchSubagentLifecycle(options, abortSignal, "SubagentStop", {
          subagentId,
          subagentType: definition.id,
          success: true,
        });
        lifecycleStopped = true;
        options.dependencies.eventEmitter?.({
          type: "subagent_completed",
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          success: true,
          durationMs: report.durationMs,
        });
        completedEventEmitted = true;
        if (observerDefinition) {
          await launchObserverSubagent({
            options,
            api,
            definitions,
            observedDefinition: definition,
            observerDefinition,
            observedSubagentId: subagentId,
            activity: observerActivity,
            directive,
            observerMessage: definition.observerMessage,
            timeoutMs,
            outcome: { success: true, markdown: report.markdown },
          });
        }
        return {
          markdown: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          parsed: report.parsed as Record<string, string> | undefined,
          subagentSessionId,
          ...(sidechain?.transcriptRelativePath
            ? { transcriptRelativePath: sidechain.transcriptRelativePath }
            : {}),
        };
      } catch (error) {
        const timedOut = abort.timedOut();
        const aborted = Boolean(abortSignal?.aborted && !timedOut);
        let failure: unknown = timedOut
          ? new Error(`Subagent timed out after ${effectiveTimeoutMs}ms.`)
          : error;
        try {
          await disposeSidechain();
        } catch (disposeError) {
          failure = new AggregateError(
            [failure, disposeError],
            "Subagent failed and its sidechain storage could not be disposed.",
          );
        }
        // Storage or parent-start failures have no durable started fact, so
        // they must not leave behind an unmatched terminal record.
        if (startedRecorded && !completionAttempted) {
          completionAttempted = true;
          try {
            await transcript?.recordSubagentCompleted?.({
              sessionId: options.sessionId,
              turnId: options.turnId,
              subagentId,
              subagentType: definition.id,
              summary: failure instanceof Error ? failure.message : String(failure),
              turns: 0,
              durationMs: 0,
              errored: true,
            });
          } catch (completionError) {
            failure = new AggregateError(
              [failure, completionError],
              "Subagent failed and its parent completion could not be recorded.",
            );
          }
        }
        if (lifecycleStarted && !lifecycleStopped) {
          try {
            await dispatchSubagentLifecycle(options, abortSignal, "SubagentStop", {
              subagentId,
              subagentType: definition.id,
              success: false,
            });
            lifecycleStopped = true;
          } catch (lifecycleError) {
            failure = new AggregateError(
              [failure, lifecycleError],
              "Subagent failed and its stop lifecycle hook could not be dispatched.",
            );
          }
        }
        if (startedEventEmitted && !completedEventEmitted) {
          try {
            options.dependencies.eventEmitter?.({
              type: "subagent_completed",
              sessionId: options.sessionId,
              turnId: options.turnId,
              subagentId,
              subagentType: definition.id,
              success: false,
              aborted,
              durationMs: 0,
            });
            completedEventEmitted = true;
          } catch (eventError) {
            failure = new AggregateError(
              [failure, eventError],
              "Subagent failed and its completion event could not be emitted.",
            );
          }
        }
        if (observerDefinition) {
          try {
            await launchObserverSubagent({
              options,
              api,
              definitions,
              observedDefinition: definition,
              observerDefinition,
              observedSubagentId: subagentId,
              activity: observerActivity,
              directive,
              observerMessage: definition.observerMessage,
              timeoutMs,
              outcome: {
                success: false,
                error: failure instanceof Error ? failure.message : String(failure),
              },
            });
          } catch (observerError) {
            failure = new AggregateError(
              [failure, observerError],
              "Subagent failed and its observer could not be launched.",
            );
          }
        }
        throw failure;
      } finally {
        abort.dispose();
      }
    },
  };
  return api;
}

async function launchObserverSubagent(input: {
  options: OneShotSubagentPortOptions & OneShotSubagentPortRequest;
  api: PilotDeckSubagentForkApi;
  definitions: Record<string, SubagentDefinition>;
  observedDefinition: SubagentDefinition;
  observerDefinition: SubagentDefinition;
  observedSubagentId: string;
  activity: AgentEvent[];
  directive: string;
  observerMessage?: string;
  timeoutMs?: number;
  outcome: ObserverOutcome;
}): Promise<void> {
  const launcher = input.options.dependencies.observerSubagents;
  if (!launcher) {
    throw new Error(`Observer definition ${input.observerDefinition.id} requires a host observer-subagent launcher.`);
  }
  const observerSubagentId = input.options.dependencies.uuid?.() ?? randomUUID();
  const observerDefinition: SubagentDefinition = {
    ...input.observerDefinition,
    allowedTools: [],
    disallowedTools: [],
    isReadOnly: true,
    permissionMode: "plan",
    mcpServers: undefined,
    skills: undefined,
    memory: "disabled",
    initialPrompt: undefined,
    background: undefined,
    observer: undefined,
    observerMessage: undefined,
  };
  const digest = buildObserverActivityDigest({
    observedDefinition: input.observedDefinition,
    directive: input.directive,
    activity: input.activity,
    observerMessage: input.observerMessage,
    outcome: input.outcome,
  });

  await launcher.launch({
    sessionId: input.options.sessionId,
    turnId: input.options.turnId,
    observedSubagentId: input.observedSubagentId,
    observerSubagentId,
    observerSubagentType: observerDefinition.id,
    run: async (abortSignal) => {
      const startedAt = (input.options.dependencies.now?.() ?? new Date()).getTime();
      try {
        const report = await input.api.fork({
          definitionId: observerDefinition.id,
          directive: digest,
          subagentId: observerSubagentId,
          abortSignal,
          timeoutMs: input.timeoutMs,
          suppressAutoObserver: true,
          definitionOverride: observerDefinition,
        } as InternalSubagentForkInput);
        input.options.dependencies.eventEmitter?.({
          type: "observer_report",
          sessionId: input.options.sessionId,
          turnId: input.options.turnId,
          observedSubagentId: input.observedSubagentId,
          observedSubagentType: input.observedDefinition.id,
          observerSubagentId,
          observerSubagentType: observerDefinition.id,
          success: true,
          report: report.markdown,
          durationMs: (input.options.dependencies.now?.() ?? new Date()).getTime() - startedAt,
        });
      } catch (error) {
        input.options.dependencies.eventEmitter?.({
          type: "observer_report",
          sessionId: input.options.sessionId,
          turnId: input.options.turnId,
          observedSubagentId: input.observedSubagentId,
          observedSubagentType: input.observedDefinition.id,
          observerSubagentId,
          observerSubagentType: observerDefinition.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: (input.options.dependencies.now?.() ?? new Date()).getTime() - startedAt,
        });
        throw error;
      }
    },
  });
}

function buildObserverActivityDigest(input: {
  observedDefinition: SubagentDefinition;
  directive: string;
  activity: AgentEvent[];
  observerMessage?: string;
  outcome: ObserverOutcome;
}): string {
  const activity = input.activity
    .map(observerActivityLine)
    .filter((line): line is string => line !== undefined);
  return truncateObserverText([
    "You are an observer. Do not execute the observed task or attempt to change its outcome.",
    "Review this read-only activity digest and produce a concise report of risks, failures, or notable findings.",
    "",
    `Observed agent: ${input.observedDefinition.id}`,
    `Observed directive: ${truncateObserverText(input.directive, 2_000)}`,
    "",
    "Activity:",
    ...(activity.length > 0 ? activity.map((line) => `- ${line}`) : ["- No observable model or tool activity was recorded."]),
    "",
    `Outcome: ${input.outcome.success ? "completed" : "failed"}`,
    ...(input.outcome.markdown ? ["Observed final report:", truncateObserverText(input.outcome.markdown, 4_000)] : []),
    ...(input.outcome.error ? [`Observed error: ${truncateObserverText(input.outcome.error, 1_000)}`] : []),
    ...(input.observerMessage?.trim() ? ["", input.observerMessage.trim()] : []),
  ].join("\n"), OBSERVER_MAX_TEXT_CHARS);
}

function observerActivityLine(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "model_request_started":
      return `model request: ${event.provider}/${event.model}`;
    case "tool_calls_detected":
      return `tool calls: ${event.calls.map((call) => call.name).join(", ") || "none"}`;
    case "tool_result":
      return `tool result: ${event.result.toolName} (${event.result.type === "success" ? "success" : "error"})`;
    case "assistant_message":
      return "assistant response emitted";
    case "warning":
      return `warning: ${truncateObserverText(event.code, 120)}`;
    case "agent_status":
      return `agent status: ${truncateObserverText(event.event, 120)}`;
    default:
      return undefined;
  }
}

function truncateObserverText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 72))}\n\n[observer digest truncated]`;
}

async function dispatchSubagentLifecycle(
  options: OneShotSubagentPortOptions & Pick<OneShotSubagentPortRequest, "sessionId" | "turnId">,
  abortSignal: AbortSignal | undefined,
  event: PilotDeckHookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  await options.dependencies.lifecycle?.dispatch({
    event,
    baseInput: {
      sessionId: options.sessionId,
      transcriptPath: "",
      cwd: options.config.cwd,
      permissionMode: options.config.permissionMode,
    },
    payload,
    matchQuery: event,
    signal: abortSignal,
    env: buildTurnEnvironment(
      options.config.env,
      options.config.cwd,
      options.sessionId,
      options.turnId,
    ),
  });
}

function composeAbortSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  const forwardParentAbort = () => controller.abort(parent?.reason ?? "subagent_parent_aborted");
  if (parent?.aborted) forwardParentAbort();
  else parent?.addEventListener("abort", forwardParentAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timeout = true;
    controller.abort("subagent_timeout");
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timeoutId);
      parent?.removeEventListener("abort", forwardParentAbort);
    },
  };
}
