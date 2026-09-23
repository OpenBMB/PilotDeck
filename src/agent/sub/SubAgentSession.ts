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
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import {
  AgentSessionRuntimeBundle,
  type AgentSessionRuntimeResources,
} from "../session/AgentSessionRuntimeBundle.js";
import { createAgentTurnCapabilities } from "../loop/nativeAgentTurnCapabilitiesAdapter.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { ToolRegistry } from "../../tool/registry/ToolRegistry.js";
import { McpRuntime, createMcpToolDefinitionsFromRuntime } from "../../mcp/index.js";
import type { CanonicalAssistantTextSummary } from "./types.js";
import type {
  CanonicalMessage,
} from "../../model/index.js";
import { messageContent } from "../../model/protocol/clone.js";
import {
  buildForkedMessages,
} from "./buildForkedMessages.js";
import type { SubagentDefinition, SubagentMcpServerConfig } from "./builtinSubagentTypes.js";
import {
  cloneReadFileState,
  cloneWriteSnapshots,
} from "./contextInheritance.js";
import {
  buildSubagentRuntimeConfig,
  createSubagentRuntimeComposition,
} from "./SubagentRuntimeComposition.js";
import {
  createNativeSubagentProvider,
  type SidechainTranscriptWriter,
  type SubagentReport,
  type SubagentRunRequest,
} from "./SubagentProvider.js";
import {
  snapshotSubagentDescriptor,
  type SubagentDescriptorData,
} from "./SubagentDescriptor.js";
import { SUBAGENT_DESCRIPTOR_METADATA_KEY } from "./SubagentDescriptorPersistence.js";


const SUMMARY_FIELDS = ["Scope", "Result", "Key files", "Files changed", "Issues"] as const;

export type SubAgentSessionOptions = Omit<SubagentRunRequest, "mode">;
export type { SidechainTranscriptWriter, SubagentReport } from "./SubagentProvider.js";

export class SubAgentSession {
  constructor(private readonly options: SubAgentSessionOptions) {}

  /** @deprecated Compatibility surface retained for legacy parity tests. */
  buildScopedRegistry() {
    const composition = createSubagentRuntimeComposition({
      definition: this.options.definition,
      subagentId: this.options.subagentId,
      parentSessionId: this.options.parentSessionId,
      parentConfig: this.options.parentConfig,
      parentDependencies: this.options.parentDependencies,
    });
    return composition.dependencies.tools.registry;
  }

  /** @deprecated Compatibility surface retained for legacy parity tests. */
  createScopedRuntime() {
    return createSubagentRuntimeComposition({
      definition: this.options.definition,
      subagentId: this.options.subagentId,
      parentSessionId: this.options.parentSessionId,
      parentConfig: this.options.parentConfig,
      parentDependencies: this.options.parentDependencies,
    });
  }

  /** @deprecated Compatibility surface retained for legacy parity tests. */
  buildConfig(): AgentRuntimeConfig {
    return buildSubagentRuntimeConfig({
      definition: this.options.definition,
      subagentId: this.options.subagentId,
      parentConfig: this.options.parentConfig,
    });
  }

  async run(): Promise<SubagentReport> {
    const providers = this.options.parentDependencies.scope?.services.subagentProviders
      ?? this.options.parentDependencies.subagentProviders;
    if (providers) {
      const requested = this.options.parentDependencies.scope?.services.subagentProvider
        ?? this.options.parentDependencies.subagentProvider;
      const named = requested
        ? providers.get(requested.name)
        : providers.list().length === 1
          ? providers.list()[0]
          : undefined;
      if (!named) {
        throw new Error("Subagent provider is not uniquely selected in the current scope.");
      }
      const run = await providers.start(named.name, { ...this.options, mode: "one-shot" });
      try {
        return await run.result;
      } finally {
        await run.dispose("subagent_session_settled");
      }
    }
    const provider = this.options.parentDependencies.scope?.services.subagentProvider
      ?? this.options.parentDependencies.subagentProvider
      ?? createNativeSubagentProvider();
    const request = {
      ...this.options,
      mode: "one-shot" as const,
      descriptor: snapshotSubagentDescriptor({
        mode: "one-shot",
        provider: provider.name,
        definitionId: this.options.definition.id,
      }),
    };
    if (provider.start) {
      const run = await provider.start(request);
      try {
        return await run.result;
      } finally {
        await run.dispose("subagent_session_settled");
      }
    }
    if (provider.run) return provider.run(request);
    throw new Error(`Subagent provider "${provider.name}" does not support one-shot runs.`);
  }

  /**
   * Native provider implementation. Kept public for the provider adapter and
   * intentionally bypasses the optional provider on parent dependencies.
   */
  async runNative(descriptor?: SubagentDescriptorData): Promise<SubagentReport> {
    const startedAt = Date.now();

    const messages = this.buildInitialMessages();
    const scopedRuntime = createSubagentRuntimeComposition({
      definition: this.options.definition,
      subagentId: this.options.subagentId,
      parentSessionId: this.options.parentSessionId,
      parentConfig: this.options.parentConfig,
      parentDependencies: this.options.parentDependencies,
    });
    const subDependencies = scopedRuntime.dependencies;
    const subConfig = scopedRuntime.config;
    const sidechain = this.resolveSidechainTranscript();
    let sidechainRuntime: AgentSessionRuntimeResources | undefined;
    let definitionMcp: McpRuntime | undefined;
    try {
      definitionMcp = await this.attachDefinitionMcpTools(subDependencies.tools.registry);
      this.options.parentDependencies.subagentComposition?.configureTools?.(
        this.options.definition,
        subDependencies.tools.registry,
      );
      sidechainRuntime = sidechain?.recordSessionEvent
        ? new AgentSessionRuntimeBundle({
            sessionId: this.options.subagentSessionId,
            config: subConfig,
            dependencies: subDependencies,
            transcript: createSidechainTranscriptWriter(sidechain),
            ownedScope: false,
          }).compose()
        : undefined;
      const executionDependencies = sidechainRuntime?.dependencies ?? subDependencies;
      const executionCapabilities = sidechainRuntime?.capabilities
        ?? createAgentTurnCapabilities(subConfig, executionDependencies);
      const loop = new AgentLoop(subConfig, executionCapabilities, {
        readFileState: cloneReadFileState(this.options.parentReadFileState),
        writeSnapshots: cloneWriteSnapshots(this.options.parentWriteSnapshots),
      });

      let last: AgentLoopRunResult | undefined;
      const turnId = `${this.options.subagentId}-t0`;
      if (sidechainRuntime) {
        await sidechainRuntime.eventRecorder.startTurn(this.options.subagentSessionId, turnId);
      }
      if (sidechain) {
        await sidechain.recordAcceptedInput(
          this.options.subagentSessionId,
          turnId,
          messages,
          {
            [SUBAGENT_DESCRIPTOR_METADATA_KEY]: descriptor ?? snapshotSubagentDescriptor({
              mode: "one-shot",
              provider: "pilotdeck-native",
              definitionId: this.options.definition.id,
            }),
          },
        );
      }
      const generator = loop.run({
        sessionId: this.options.subagentSessionId,
        turnId,
        workspaceId: this.options.workspaceId,
        storageConfigVersion: this.options.storageConfigVersion,
        invocationLogSink: this.options.invocationLogSink,
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
        this.options.onActivity?.(event);
        this.forwardActivity(event);
        if (
          sidechain &&
          (event.type === "assistant_message" || event.type === "tool_results_projected")
        ) {
          await sidechain.recordDurableMessage(
            this.options.subagentSessionId,
            turnId,
            event.message,
          );
        }
      }
      if (!last) {
        throw new Error("SubAgentSession: AgentLoop returned no result");
      }
      await sidechainRuntime?.eventRecorder.completeTurn(last.result);
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
      } finally {
      const errors: unknown[] = [];
      try {
        await sidechainRuntime?.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await definitionMcp?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await scopedRuntime.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose one-shot subagent runtime.");
      }
    }
  }

  private buildInitialMessages(): CanonicalMessage[] {
    return buildForkedMessages(this.options.directive, this.options.definition.initialPrompt);
  }

  private resolveSidechainTranscript(): SidechainTranscriptWriter | undefined {
    return this.options.sidechainTranscript;
  }

  /** Start only this definition's MCP endpoints and add their native tools. */
  private async attachDefinitionMcpTools(registry: ToolRegistry): Promise<McpRuntime | undefined> {
    const configured = this.options.definition.mcpServers;
    if (!configured || Object.keys(configured).length === 0) return undefined;
    const runtime = new McpRuntime(
      Object.entries(configured).map(([id, config]) => toSubagentMcpServerSpec(id, config)),
    );
    try {
      await runtime.start();
      const allowed = new Set(this.options.definition.allowedTools);
      const denied = new Set(this.options.definition.disallowedTools ?? []);
      const wildcard = allowed.has("*");
      for (const tool of await createMcpToolDefinitionsFromRuntime(runtime)) {
        if ((!wildcard && !allowed.has(tool.name)) || denied.has(tool.name)) continue;
        registry.registerOrReplace(tool);
      }
      return runtime;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
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
        timeline: event.timeline,
        blockId: event.blockId,
        streamBoundary: event.streamBoundary,
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
    if (event.type === "compact_started" || event.type === "compact_completed") {
      emit({ type: "agent_status", ...base, event: `subagent_${event.type}`, timeline: event.timeline,
        detail: { ...event, subagentId: base.subagentId } });
      return;
    }
    if (event.type === "assistant_message") {
      for (const block of event.message.content) {
        if ((block.type === "text" || block.type === "thinking") && block.timeline) emit({
          type: "agent_status", ...base, event: "subagent_assistant_block", timeline: block.timeline,
          detail: { subagentId: base.subagentId, kind: block.type, text: block.text, blockId: block.blockId },
        });
      }
      return;
    }
    if (event.type === "tool_result") {
      emit({
        type: "subagent_tool_result",
        ...base,
        result: event.result,
        timeline: event.timeline,
      });
    }
  }

}

function createSidechainTranscriptWriter(
  sidechain: NonNullable<SubAgentSessionOptions["sidechainTranscript"]>,
): AgentTranscriptWriter {
  const recordSessionEvent = sidechain.recordSessionEvent;
  if (!recordSessionEvent) {
    throw new Error("One-shot durable subagent composition requires recordSessionEvent.");
  }
  return {
    recordSessionEvent: recordSessionEvent.bind(sidechain),
    recordAcceptedInput: sidechain.recordAcceptedInput.bind(sidechain),
    recordDurableMessage: sidechain.recordDurableMessage.bind(sidechain),
    recordTurnResult: sidechain.recordTurnResult?.bind(sidechain) ?? (() => undefined),
  };
}

function toSubagentMcpServerSpec(
  id: string,
  config: SubagentMcpServerConfig,
): import("../../mcp/protocol/types.js").PilotDeckMcpServerSpec {
  if (config.type === "stdio") {
    return {
      id,
      transport: "stdio",
      command: config.command,
      ...(config.args?.length ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
    };
  }
  if (config.type === "sse") {
    return {
      id,
      transport: "sse",
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
    };
  }
  return {
    id,
    transport: "streamable_http",
    url: config.url,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
  };
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
