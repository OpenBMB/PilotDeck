import type { CanonicalMessage } from "../../model/index.js";
import type { DynamicContextStore } from "../../context/dynamic/DynamicContextStore.js";
import type { ArtifactContractStore } from "../../artifact/index.js";
import type { DomainPluginRuntime } from "../../extension/index.js";
import { HookRuntime } from "../../extension/hooks/execution/HookRuntime.js";
import { createHookInput } from "../../extension/hooks/protocol/input.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "../protocol/payloads.js";
import { emptyLifecycleDispatchResult } from "../protocol/payloads.js";

export class LifecycleRuntime {
  constructor(
    private readonly hooks = new HookRuntime(),
    private readonly dynamicContext?: DynamicContextStore,
    private readonly artifactContracts?: ArtifactContractStore,
    private readonly domainPlugins?: DomainPluginRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult> {
    try {
      const domainResult = input.event === "UserPromptSubmit"
        && input.payload?.internal !== true
        && typeof input.payload?.prompt === "string"
        ? await this.domainPlugins?.activate({
            sessionId: input.baseInput.sessionId,
            cwd: input.baseInput.cwd,
            prompt: input.payload.prompt,
          })
        : undefined;
      const hookInput = createHookInput(input.event, input.baseInput, input.payload);
      const hookResult = await this.hooks.run({
        event: input.event,
        hookInput,
        matchQuery: input.matchQuery,
        cwd: input.baseInput.cwd,
        env: input.env,
        signal: input.signal,
      });

      const isPreModelRequest = input.event === "PreModelRequest";
      if (!isPreModelRequest) this.registerDynamicContext(input, hookResult.effects);
      this.registerArtifactContracts(input, hookResult.effects);

      return {
        effects: hookResult.effects,
        messages: this.dynamicContext && !isPreModelRequest ? [] : createMessagesFromEffects(hookResult.effects),
        events: hookResult.events,
        blockingErrors: hookResult.blockingErrors,
        nonBlockingErrors: [...hookResult.nonBlockingErrors, ...(domainResult?.errors ?? [])],
      };
    } finally {
      if (input.event === "SessionEnd") {
        this.dynamicContext?.clear(input.baseInput.sessionId);
        this.artifactContracts?.clear(input.baseInput.sessionId);
      }
    }
  }

  private registerArtifactContracts(
    input: LifecycleDispatchInput,
    effects: LifecycleDispatchResult["effects"],
  ): void {
    if (!this.artifactContracts) return;
    for (const effect of effects) {
      if (effect.type !== "artifact_contracts") continue;
      this.artifactContracts.register(input.baseInput.sessionId, effect.sourcePluginId, effect.contracts);
    }
  }

  private registerDynamicContext(
    input: LifecycleDispatchInput,
    effects: LifecycleDispatchResult["effects"],
  ): void {
    if (!this.dynamicContext) return;
    let index = 0;
    for (const effect of effects) {
      if (effect.type !== "additional_context") continue;
      this.dynamicContext.register({
        sessionId: input.baseInput.sessionId,
        turnId: typeof input.payload?.turnId === "string" ? input.payload.turnId : undefined,
        source: effect.source,
        id: `${input.event}:${effect.id ?? index++}`,
        content: effect.content,
        priority: effect.priority,
        expiresAt: effect.ttlMs === undefined ? undefined : this.now() + effect.ttlMs,
      });
    }
  }
}

export class NullLifecycleRuntime extends LifecycleRuntime {
  constructor() {
    super(new HookRuntime({}));
  }

  override async dispatch(): Promise<LifecycleDispatchResult> {
    return emptyLifecycleDispatchResult();
  }
}

function createMessagesFromEffects(effects: LifecycleDispatchResult["effects"]): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const effect of effects) {
    if (effect.type === "additional_context") {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `<hook_context source="${effect.source}">\n${effect.content}\n</hook_context>`,
          },
        ],
      });
    }
  }
  return messages;
}
