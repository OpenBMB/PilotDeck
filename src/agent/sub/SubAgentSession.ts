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

    const messages = this.buildInitialMessages();
    const subRegistry = this.buildScopedRegistry();
    const subDependencies = this.cloneDependencies(subRegistry);
    const subConfig = this.buildConfig();

    const loop = new AgentLoop(subConfig, subDependencies, {
      readFileState: cloneReadFileState(this.options.parentReadFileState),
      writeSnapshots: cloneWriteSnapshots(this.options.parentWriteSnapshots),
    });

    let last: AgentLoopRunResult | undefined;
    const turnId = `${this.options.subagentId}-t0`;
    if (this.options.sidechainTranscript) {
      await this.options.sidechainTranscript.recordAcceptedInput(
        this.options.subagentSessionId,
        turnId,
        messages,
      );
    }
    const generator = loop.run({
      sessionId: this.options.subagentSessionId,
      turnId,
      messages,
      maxTurns: this.options.maxTurns,
      abortSignal: this.options.abortSignal,
    });
    while (true) {
      const next = await generator.next();
      if (next.done) {
        last = next.value;
        break;
      }
      const event = next.value;
      this.forwardActivity(event);
      if (
        this.options.sidechainTranscript &&
        (event.type === "assistant_message" || event.type === "tool_results_projected")
      ) {
        await this.options.sidechainTranscript.recordDurableMessage(
          this.options.subagentSessionId,
          turnId,
          event.type === "assistant_message" ? event.message : event.message,
        );
      }
    }
    if (!last) {
      throw new Error("SubAgentSession: AgentLoop returned no result");
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
    return buildForkedMessages(this.options.directive);
  }

  private buildScopedRegistry(): ToolRegistry {
    const scoped = new ToolRegistry();
    const allowedSet = new Set(this.options.definition.allowedTools);
    const wildcard = allowedSet.has("*");
    const forceReadOnly = this.options.definition.isReadOnly
      || this.options.parentConfig.permissionMode === "plan"
      || this.options.parentConfig.runMode === "ask";
    for (const tool of this.options.parentDependencies.tools.registry.list()) {
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
      if (forceReadOnly && !tool.isReadOnly({} as never)) {
        continue; // S9 — read-only subagents reject side-effecting tools outright.
      }
      if (!wildcard && !allowedSet.has(tool.name)) continue;
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
      subagentTranscript: this.options.parentDependencies.subagentTranscript,
    };
  }

  private buildConfig(): AgentRuntimeConfig {
    const parent = this.options.parentConfig;
    const subagentSystem = buildSubagentSystemPrompt(this.options.definition);
    const filteredParentSystem = applySystemPromptFilters(
      parent.systemPrompt ?? "",
      this.options.definition,
    );
    const systemPrompt = filteredParentSystem.length > 0
      ? `${subagentSystem}\n\n${filteredParentSystem}`
      : subagentSystem;
    return {
      ...parent,
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
