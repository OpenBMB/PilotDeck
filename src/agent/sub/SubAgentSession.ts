/**
 * `SubAgentSession` — wraps `AgentLoop.run` for a forked subagent invocation
 * (C2 §6.2). Builds the forked message sequence, scopes the tool registry to
 * `allowedTools`, drops project-instructions / git-status from the system prompt, and
 * collects the final assistant report into a {@link SubagentReport}.
 *
 * The subagent always returns a single text report — even if the model
 * produces extra tool calls, we trust the AgentLoop to drive them to a
 * terminal `assistant_message` whose text we extract.
 */

import {
  AgentLoop,
  type AgentLoopRunResult,
} from "../loop/AgentLoop.js";
import type { AgentEvent } from "../protocol/events.js";
import type {
  CanonicalAssistantTextSummary,
} from "./types.js";
import type {
  CanonicalMessage,
  CanonicalUsage,
} from "../../model/index.js";
import { messageContent } from "../../model/protocol/clone.js";
import { cloneMessages } from "../../model/index.js";
import type { AgentControlBoundaryTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { ToolRegistry } from "../../tool/registry/ToolRegistry.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckToolDefinition,
  PilotDeckWriteSnapshotMap,
} from "../../tool/index.js";
import { ConcurrentToolScheduler } from "../../tool/scheduler/ConcurrentToolScheduler.js";
import { ToolRuntime } from "../../tool/execution/ToolRuntime.js";
import { PermissionRuntime } from "../../permission/index.js";
import {
  buildForkedMessages,
} from "./buildForkedMessages.js";
import {
  buildSubagentSystemPrompt,
  type SubagentDefinition,
} from "./builtinSubagentTypes.js";
import {
  applySystemPromptFilters,
  cloneReadFileState,
  cloneWriteSnapshots,
} from "./contextInheritance.js";
import { SubagentContinuationError } from "./continuation.js";


const SUMMARY_FIELDS = ["Scope", "Result", "Key files", "Files changed", "Issues"] as const;

export type SubAgentSessionOptions = {
  /** The subagent preset (general-purpose / explore / plan). */
  definition: SubagentDefinition;
  /** Free-text directive from the parent (becomes the subagent's user prompt). */
  directive: string;
  /** Parent agent's runtime config (provider, model, permission mode, ...). */
  parentConfig: AgentRuntimeConfig;
  /** Parent agent's runtime dependencies (model, scheduler factory, ...). */
  parentDependencies: AgentRuntimeDependencies;
  /** Parent agent's read-file deduplication cache (cloned into the child). */
  parentReadFileState?: PilotDeckReadFileStateMap;
  /** Parent agent's write snapshots (cloned into the child). */
  parentWriteSnapshots?: PilotDeckWriteSnapshotMap;
  /** Parent session/turn scope used for forwarding child activity to hosts. */
  parentSessionId: string;
  parentTurnId: string;
  /** New session id for the fork's transcript writer (C3 sidechain hook). */
  subagentSessionId: string;
  /** Stable subagent UUID — mirrors C3 sidechain naming. */
  subagentId: string;
  /**
   * task_id continuation: prior durable child messages restored from the
   * sidechain transcript. The new `directive` is appended as the only new
   * message; the child identity (definition / provider / model / session id)
   * stays the one saved with the task.
   */
  priorMessages?: CanonicalMessage[];
  /**
   * Round index for continuation runs — produces unique follow-up turn ids
   * (`<subagentId>-t<index>`). Defaults to 0 (first fork round).
   */
  turnIndex?: number;
  /**
   * task_id continuation: provider/model pinned from the task's saved
   * metadata, so a parent reload or changed subagent-model config cannot
   * silently switch the child's model.
   */
  continuationModel?: {
    provider: string;
    model: string;
    modelMultimodal?: import("../../model/index.js").MultimodalConstraints;
  };
  /** Optional cap on AgentLoop turns inside the fork. Unbounded when omitted. */
  maxTurns?: number;
  /** Abort signal forwarded to the child loop. */
  abortSignal?: AbortSignal;
  /**
   * Optional sidechain transcript writer for C3. When provided, each
   * AgentLoop event that produces a durable message is mirrored here. The
   * parent transcript only gets the started/completed reference entries.
   */
  sidechainTranscript?: SidechainTranscriptWriter;
};

/** Unique per-round turn id inside a sidechain transcript. */
export function subagentTurnId(subagentId: string, turnIndex: number): string {
  return `${subagentId}-t${turnIndex}`;
}

/**
 * Minimal sidechain writer surface used by SubAgentSession. Lives in this
 * module so `agent/sub` doesn't import the session storage layer directly
 * (the parent constructs the writer and passes it in).
 */
export type SidechainTranscriptWriter = {
  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void>;
  /** Terminal result of the round — required for replayable transcripts. */
  recordTurnResult?(
    sessionId: string,
    turnId: string,
    result: import("../protocol/result.js").AgentTurnResult,
  ): Promise<void>;
  /** Compaction boundary inside the sidechain (replay slices after it). */
  recordControlBoundary?(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): Promise<void>;
  /** Identity/runtime metadata for the sidechain (task_id continuation). */
  recordSessionMetadata?(
    sessionId: string,
    turnId: string,
    metadata: import("../../session/transcript/TranscriptEntry.js").SessionMetadataValue,
  ): Promise<void>;
};

export type SubagentReport = {
  subagentId: string;
  definitionId: string;
  /** Final assistant text (the 5-field report). */
  markdown: string;
  /** Parsed `Scope/Result/Key files/Files changed/Issues` summary. */
  parsed?: CanonicalAssistantTextSummary;
  /** Aggregate usage from the AgentLoop run. */
  usage: CanonicalUsage;
  /** Number of internal turns taken. */
  turns: number;
  durationMs: number;
};

export class SubAgentSession {
  constructor(private readonly options: SubAgentSessionOptions) {}

  async run(): Promise<SubagentReport> {
    const startedAt = Date.now();

    const turnId = subagentTurnId(this.options.subagentId, this.options.turnIndex ?? 0);
    const messages = this.buildInitialMessages();
    // Continuation rounds append ONLY the new directive to the transcript —
    // the prior history is already durable there from earlier rounds.
    const acceptedInputMessages = this.options.priorMessages?.length
      ? messages.slice(messages.length - 1)
      : messages;
    const subRegistry = this.buildScopedRegistry();
    const subDependencies = this.cloneDependencies(subRegistry);
    const subConfig = this.buildConfig();
    let usedModel = { provider: subConfig.provider, model: subConfig.model };

    const loop = new AgentLoop(subConfig, subDependencies, {
      readFileState: cloneReadFileState(this.options.parentReadFileState),
      writeSnapshots: cloneWriteSnapshots(this.options.parentWriteSnapshots),
    });

    let last: AgentLoopRunResult | undefined;
    const sidechain = this.options.sidechainTranscript;
    const sidechainSessionId = this.options.subagentSessionId;
    if (sidechain) {
      await sidechain.recordAcceptedInput(sidechainSessionId, turnId, acceptedInputMessages);
      // Persist the child's identity/runtime/model so a continuation after a
      // parent session reload restores the same child. No permission state is
      // recorded — current parent permissions always apply.
      await sidechain.recordSessionMetadata?.(sidechainSessionId, turnId, {
        subagentTask: {
          formatVersion: 2,
          subagentId: this.options.subagentId,
          definitionId: this.options.definition.id,
          provider: subConfig.provider,
          model: subConfig.model,
          parentSessionId: this.options.parentSessionId,
          subagentSessionId: sidechainSessionId,
        },
      });
    }
    const generator = loop.run({
      sessionId: sidechainSessionId,
      turnId,
      messages,
      maxTurns: this.options.maxTurns,
      abortSignal: this.options.abortSignal,
      modelOverride: this.options.continuationModel,
      ...(sidechain
        ? {
            onCompactPersisted: async ({
              boundary,
              messages: compactMessages,
            }: {
              boundary: AgentControlBoundaryTranscriptEntry["boundary"];
              messages: CanonicalMessage[];
            }) => {
              // Mirror the parent-side persistence contract: boundary first,
              // then the compact replacement messages (replay slices the
              // history after the boundary).
              await sidechain.recordControlBoundary?.(sidechainSessionId, turnId, boundary);
              for (const message of compactMessages) {
                await sidechain.recordDurableMessage(sidechainSessionId, turnId, message);
              }
            },
          }
        : {}),
    });
    while (true) {
      const next = await generator.next();
      if (next.done) {
        last = next.value;
        break;
      }
      const event = next.value;
      if (event.type === "model_event" && event.event.type === "request_started") {
        usedModel = { provider: event.event.provider, model: event.event.model };
      }
      this.forwardActivity(event);
      if (
        sidechain &&
        (event.type === "assistant_message" || event.type === "tool_results_projected")
      ) {
        await sidechain.recordDurableMessage(
          sidechainSessionId,
          turnId,
          event.message,
        );
      }
    }
    if (!last) {
      throw new Error("SubAgentSession: AgentLoop returned no result");
    }
    // Record the terminal result BEFORE surfacing failure: the round is
    // durable either way, and replay only trusts turns with a turn_result.
    // The continuation loader refuses rounds whose result is not a success,
    // so failed rounds keep their context separate from any future attempt.
    if (sidechain) {
      await sidechain.recordSessionMetadata?.(sidechainSessionId, turnId, {
        subagentTask: {
          formatVersion: 2,
          subagentId: this.options.subagentId,
          definitionId: this.options.definition.id,
          ...usedModel,
          parentSessionId: this.options.parentSessionId,
          subagentSessionId: sidechainSessionId,
        },
      });
      await sidechain.recordTurnResult?.(sidechainSessionId, turnId, last.result);
    }
    if (last.result.type === "aborted") {
      throw new Error(
        `SubAgentSession: subagent turn aborted (${last.result.stopReason})`,
      );
    }
    if (last.result.type === "error") {
      const details = last.result.errors?.map((error) => error.message).join("; ");
      throw new Error(
        `SubAgentSession: subagent turn failed (${last.result.stopReason})${details ? `: ${details}` : ""}`,
      );
    }
    const text = extractFinalAssistantText(last.messages);
    const parsed = parseSummary(text);
    return {
      subagentId: this.options.subagentId,
      definitionId: this.options.definition.id,
      markdown: text,
      parsed,
      usage: last.result.usage,
      turns: last.result.turns,
      durationMs: Date.now() - startedAt,
    };
  }

  private buildInitialMessages(): CanonicalMessage[] {
    const prior = this.options.priorMessages;
    if (prior && prior.length > 0) {
      // task_id continuation: restored durable history followed by exactly
      // one new user directive.
      const directiveMessage: CanonicalMessage = {
        role: "user",
        content: [{ type: "text", text: this.options.directive }],
      };
      return [...cloneMessages(prior), directiveMessage];
    }
    return buildForkedMessages(this.options.directive);
  }

  private buildScopedRegistry(): ToolRegistry {
    const scoped = new ToolRegistry();
    const allowedSet = new Set(this.options.definition.allowedTools);
    const wildcard = allowedSet.has("*");
    for (const tool of this.options.parentDependencies.tools.registry.list()) {
      if (!wildcard && !allowedSet.has(tool.name)) {
        continue;
      }
      if (tool.name === "enter_plan_mode" || tool.name === "exit_plan_mode") {
        continue; // Subagents must not participate in the plan-mode workflow.
      }
      if (tool.name === "agent") {
        continue; // Subagents must never nest-fork.
      }
      if (tool.name.startsWith("always_on_")) {
        continue; // Always-On tools require a RunContext unavailable in subagents.
      }
      if (tool.name === "ask_user_question") {
        continue; // Subagents have no elicitation channel.
      }
      scoped.register(tool as PilotDeckToolDefinition);
    }
    return scoped;
  }

  private forwardActivity(event: AgentEvent): void {
    const emit = this.options.parentDependencies.eventEmitter;
    if (!emit) return;
    const base = {
      sessionId: this.options.parentSessionId,
      turnId: this.options.parentTurnId,
      subagentId: this.options.subagentId,
      subagentType: this.options.definition.id,
    };
    if (event.type === "model_event") {
      emit({
        type: "subagent_model_event",
        ...base,
        event: event.event,
      });
      return;
    }
    if (event.type === "tool_calls_detected") {
      emit({
        type: "subagent_tool_calls_detected",
        ...base,
        calls: event.calls,
      });
      return;
    }
    if (event.type === "tool_result") {
      emit({
        type: "subagent_tool_result",
        ...base,
        result: event.result,
      });
    }
  }

  private cloneDependencies(registry: ToolRegistry): AgentRuntimeDependencies {
    const permissionRuntime = new PermissionRuntime();
    const toolRuntime = new ToolRuntime(
      registry,
      permissionRuntime,
      this.options.parentDependencies.lifecycle,
      this.options.parentDependencies.eventEmitter,
    );
    const scheduler = new ConcurrentToolScheduler(toolRuntime, registry);
    return {
      router: this.options.parentDependencies.router,
      tools: { scheduler, registry },
      context: this.options.parentDependencies.context,
      now: this.options.parentDependencies.now,
      uuid: this.options.parentDependencies.uuid,
      auditRecorder: this.options.parentDependencies.auditRecorder,
      lifecycle: this.options.parentDependencies.lifecycle,
      tokenAccounting: this.options.parentDependencies.tokenAccounting,
      getModelMaxContextTokens: this.options.parentDependencies.getModelMaxContextTokens,
      getModelMaxOutputTokens: this.options.parentDependencies.getModelMaxOutputTokens,
      getModelTokenLimits: this.options.parentDependencies.getModelTokenLimits,
      getModelMultimodal: this.options.parentDependencies.getModelMultimodal,
      getModelProtocol: this.options.parentDependencies.getModelProtocol,
      getModelSupportsPromptCache: this.options.parentDependencies.getModelSupportsPromptCache,
      subagentTranscript: this.options.parentDependencies.subagentTranscript,
    };
  }

  private buildConfig(): AgentRuntimeConfig {
    const parent = this.options.parentConfig;
    // Continuation pins the saved provider/model (child identity) ahead of
    // the parent's current subagent-model preference.
    const savedModel = this.options.continuationModel;
    let subagentModel = parent.subagentModel;
    if (savedModel) {
      const resolveLimits = this.options.parentDependencies.getModelTokenLimits;
      const limits = resolveLimits?.(savedModel.provider, savedModel.model);
      if (resolveLimits && !limits) {
        throw new SubagentContinuationError(
          "subagent_task_model_missing",
          `The saved model ${savedModel.provider}/${savedModel.model} is no longer configured. Restore it or start a new agent task.`,
        );
      }
      subagentModel = {
        ...savedModel,
        ...limits,
        modelMultimodal: this.options.parentDependencies.getModelMultimodal?.(savedModel.provider, savedModel.model),
      };
    }
    const {
      maxContextTokens: _parentMaxContextTokens,
      maxOutputTokens: _parentMaxOutputTokens,
      ...parentWithoutTokenCaps
    } = parent;
    const subagentSystem = buildSubagentSystemPrompt(this.options.definition);
    const filteredParentSystem = applySystemPromptFilters(
      parent.systemPrompt ?? "",
      this.options.definition,
    );
    const systemPrompt = filteredParentSystem.length > 0
      ? `${subagentSystem}\n\n${filteredParentSystem}`
      : subagentSystem;
    return {
      ...(subagentModel ? parentWithoutTokenCaps : parent),
      ...(subagentModel
        ? {
            provider: subagentModel.provider,
            model: subagentModel.model,
            ...(savedModel ? { subagentModel, modelMultimodal: subagentModel.modelMultimodal } : {}),
            ...(subagentModel.modelMultimodal
              ? { modelMultimodal: subagentModel.modelMultimodal }
              : {}),
          }
        : {}),
      // Ask mode performs read-only checks against each tool call's real
      // input. Do not probe dynamic isReadOnly implementations with a dummy
      // object while constructing the registry.
      runMode: this.isReadOnlySession() ? "ask" : parent.runMode,
      isSubagent: true,
      permissionContext: {
        ...parent.permissionContext,
        rules: {
          allow: parent.permissionContext.rules.allow,
          deny: parent.permissionContext.rules.deny,
          ask: parent.permissionContext.rules.ask,
        },
      },
      systemPrompt,
      stopOnStructuredOutput: false,
      metadata: {
        ...(parent.metadata ?? {}),
        subagentId: this.options.subagentId,
        subagentType: this.options.definition.id,
      },
    };
  }

  private isReadOnlySession(): boolean {
    return this.options.definition.isReadOnly
      || this.options.parentConfig.permissionMode === "plan"
      || this.options.parentConfig.runMode === "ask";
  }
}

function extractFinalAssistantText(messages: CanonicalMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of messageContent(message)) {
      if (block.type === "text") parts.push(block.text);
    }
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return "";
}

function parseSummary(text: string): CanonicalAssistantTextSummary | undefined {
  const lines = text.split("\n");
  const summary: Partial<CanonicalAssistantTextSummary> = {};
  for (const field of SUMMARY_FIELDS) {
    const idx = lines.findIndex((line) => line.startsWith(`${field}:`));
    if (idx === -1) return undefined;
    let value = lines[idx]!.slice(`${field}:`.length).trim();
    for (let j = idx + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (SUMMARY_FIELDS.some((f) => next.startsWith(`${f}:`))) break;
      value += "\n" + next;
    }
    (summary as Record<string, string>)[field] = value.trim();
  }
  return summary as CanonicalAssistantTextSummary;
}
