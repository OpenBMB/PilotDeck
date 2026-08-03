import type { PilotDeckHookEffect, PilotDeckLifecycleError } from "../../../lifecycle/protocol/effects.js";
import { matchHookMatcher } from "../config/matchHook.js";
import { matchHookCondition } from "../config/matchHookCondition.js";
import type { PilotDeckHookEvent } from "../protocol/events.js";
import type { PilotDeckHookInput } from "../protocol/input.js";
import type { PilotDeckHookOutput, PilotDeckHookSyncOutput } from "../protocol/output.js";
import type { PilotDeckHookCommand, PilotDeckHooksSettings } from "../protocol/settings.js";
import { CommandHookExecutor, PILOTDECK_SESSION_END_HOOK_TIMEOUT_MS } from "./CommandHookExecutor.js";
import { PromptHookExecutor } from "./PromptHookExecutor.js";
import { HttpHookExecutor } from "./HttpHookExecutor.js";
import { AgentHookExecutor } from "./AgentHookExecutor.js";
import { AsyncHookRegistry } from "./AsyncHookRegistry.js";
import { CallbackHookExecutor } from "./CallbackHookExecutor.js";
import { HookExecutionEventBus, type PilotDeckHookExecutionEvent } from "../events/HookExecutionEventBus.js";

export type HookRuntimeRunInput = {
  event: PilotDeckHookEvent;
  hookInput: PilotDeckHookInput;
  matchQuery?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type HookRuntimeRunResult = {
  effects: PilotDeckHookEffect[];
  events: PilotDeckHookExecutionEvent[];
  blockingErrors: PilotDeckLifecycleError[];
  nonBlockingErrors: PilotDeckLifecycleError[];
};

export class HookRuntime {
  constructor(
    private readonly settings: PilotDeckHooksSettings = {},
    private readonly commandExecutor = new CommandHookExecutor(),
    private readonly eventBus = new HookExecutionEventBus(),
    private readonly asyncRegistry = new AsyncHookRegistry(),
    private readonly promptExecutor = new PromptHookExecutor(),
    private readonly httpExecutor = new HttpHookExecutor(),
    private readonly agentExecutor = new AgentHookExecutor(),
    private readonly callbackExecutor = new CallbackHookExecutor(),
  ) {}

  /**
   * Expose the {@link CallbackHookExecutor} so the caller can register
   * per-process callbacks (e.g. the gateway's interactive permission
   * hook) before the runtime starts dispatching events.
   */
  getCallbackExecutor(): CallbackHookExecutor {
    return this.callbackExecutor;
  }

  async run(input: HookRuntimeRunInput): Promise<HookRuntimeRunResult> {
    const effects: PilotDeckHookEffect[] = [];
    const events: PilotDeckHookExecutionEvent[] = [];
    const blockingErrors: PilotDeckLifecycleError[] = [];
    const nonBlockingErrors: PilotDeckLifecycleError[] = [];

    for (const { matcher, hook } of this.matchHooks(input)) {
      const hookName = matcher.pluginName ? `${matcher.pluginName}:${hook.type}` : hook.type;
      const started: PilotDeckHookExecutionEvent = {
        type: "started",
        hookName,
        hookEvent: input.event,
      };
      events.push(started);
      this.eventBus.emit(started);

      const result = await this.executeHook(hook, input, matcher.pluginRoot);
      const response: PilotDeckHookExecutionEvent = {
        type: "response",
        hookName,
        hookEvent: input.event,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        outcome: result.outcome,
      };
      events.push(response);
      this.eventBus.emit(response);

      if (result.output.type === "async") {
        this.asyncRegistry.register({
          id: `${hookName}:${Date.now()}`,
          startedAt: new Date(),
          hookName,
          hookEvent: input.event,
          stdout: result.stdout,
          stderr: result.stderr,
          responseDelivered: false,
          asyncRewake: hook.type === "command" ? hook.asyncRewake : undefined,
        });
      }

      if (result.outcome === "blocking") {
        const message = result.stderr || result.stdout || "Hook blocked execution.";
        blockingErrors.push({ code: "hook_blocking_error", message, hookName, exitCode: result.exitCode });
        effects.push({ type: "block", reason: message });
      } else if (result.outcome === "non_blocking_error" || result.outcome === "timeout" || result.outcome === "cancelled") {
        nonBlockingErrors.push({
          code: result.outcome === "cancelled" ? "hook_cancelled" : "hook_non_blocking_error",
          message: result.stderr || result.stdout || `Hook ended with outcome ${result.outcome}.`,
          hookName,
          exitCode: result.exitCode,
        });
      }

      effects.push(...effectsFromHookOutput(result.output, hookName));
    }

    return { effects, events, blockingErrors, nonBlockingErrors };
  }

  collectAsyncResponses(): ReturnType<AsyncHookRegistry["collectResponses"]> {
    return this.asyncRegistry.collectResponses();
  }

  removeDeliveredAsyncResponses(): void {
    this.asyncRegistry.removeDelivered();
  }

  private *matchHooks(input: HookRuntimeRunInput): Generator<{
    matcher: NonNullable<PilotDeckHooksSettings[PilotDeckHookEvent]>[number];
    hook: PilotDeckHookCommand;
  }> {
    for (const matcher of this.settings[input.event] ?? []) {
      if (!matchHookMatcher(matcher.matcher, input.matchQuery)) {
        continue;
      }
      for (const hook of matcher.hooks) {
        if (
          matchHookCondition(hook.if, {
            toolName: typeof input.hookInput.toolName === "string" ? input.hookInput.toolName : undefined,
            toolInput: input.hookInput.toolInput,
          })
        ) {
          yield { matcher, hook };
        }
      }
    }
  }

  private executeHook(
    hook: PilotDeckHookCommand,
    input: HookRuntimeRunInput,
    pluginRoot: string | undefined,
  ) {
    switch (hook.type) {
      case "command":
        return this.commandExecutor.execute({
          hook,
          hookInput: input.hookInput,
          cwd: pluginRoot ?? input.cwd,
          env: input.env,
          signal: input.signal,
          timeoutMs: input.event === "SessionEnd" ? PILOTDECK_SESSION_END_HOOK_TIMEOUT_MS : undefined,
        });
      case "prompt":
        return this.promptExecutor.execute({ hook, hookInput: input.hookInput, signal: input.signal });
      case "http":
        return this.httpExecutor.execute({ hook, hookInput: input.hookInput, env: input.env, signal: input.signal });
      case "agent":
        return this.agentExecutor.execute({ hook, hookInput: input.hookInput, signal: input.signal });
      case "callback":
        return this.callbackExecutor.execute({ hook, hookInput: input.hookInput, signal: input.signal });
    }
  }
}

function effectsFromHookOutput(output: PilotDeckHookOutput, hookName: string): PilotDeckHookEffect[] {
  if (output.type === "async") {
    return [];
  }

  const effects: PilotDeckHookEffect[] = [];
  if (output.systemMessage) {
    effects.push({ type: "system_message", content: output.systemMessage });
  }
  if (isBlockingOutput(output)) {
    effects.push({
      type: "block",
      reason: output.reason ?? output.stopReason ?? "Hook blocked execution.",
      stopReason: output.stopReason,
    });
  }
  if (output.specific) {
    const specific = output.specific;
    if (specific.additionalContext) {
      effects.push({ type: "additional_context", content: specific.additionalContext, source: hookName });
    }
    if (specific.initialUserMessage) {
      effects.push({ type: "initial_user_message", message: specific.initialUserMessage });
    }
    if (specific.watchPaths?.length) {
      effects.push({ type: "watch_paths", paths: specific.watchPaths });
    }
    if (specific.worktreePath) {
      effects.push({ type: "worktree_path", path: specific.worktreePath });
    }
    if (specific.permissionDecision) {
      effects.push({
        type: "permission_decision",
        behavior: specific.permissionDecision,
        reason: specific.permissionDecisionReason,
      });
    }
    if (specific.updatedInput) {
      effects.push({ type: "updated_tool_input", input: specific.updatedInput });
    }
    if (specific.updatedMCPToolOutput !== undefined) {
      effects.push({ type: "updated_mcp_tool_output", output: specific.updatedMCPToolOutput });
    }
    if (specific.decision) {
      effects.push({ type: "permission_request_result", result: specific.decision });
    }
    if (specific.retry) {
      effects.push({ type: "retry_permission_denied" });
    }
    if (specific.modelRequestPatch) {
      effects.push({ type: "model_request_patch", patch: specific.modelRequestPatch });
    }
    if (specific.artifactContracts?.length) {
      effects.push({ type: "artifact_contracts", sourcePluginId: hookName, contracts: specific.artifactContracts });
    }
    for (const context of specific.dynamicContext ?? []) {
      effects.push({ type: "additional_context", source: hookName, ...context });
    }
  }

  return effects;
}

function isBlockingOutput(output: PilotDeckHookSyncOutput): boolean {
  return output.continue === false || output.decision === "block";
}
