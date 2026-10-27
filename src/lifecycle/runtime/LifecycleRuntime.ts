import type { CanonicalMessage } from "../../model/index.js";
import { HookRuntime } from "../../extension/hooks/execution/HookRuntime.js";
import { createHookInput } from "../../extension/hooks/protocol/input.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "../protocol/payloads.js";
import { emptyLifecycleDispatchResult } from "../protocol/payloads.js";

export class LifecycleRuntime {
  constructor(private readonly hooks = new HookRuntime()) {}

  /** Unknown dispatch implementations are conservatively treated as hooks. */
  hasHooks(input: LifecycleDispatchInput): boolean {
    if (this.dispatch !== LifecycleRuntime.prototype.dispatch) return true;
    return this.hooks.hasHooks?.({ event: input.event,
      hookInput: createHookInput(input.event, input.baseInput, input.payload),
      matchQuery: input.matchQuery, cwd: input.baseInput.cwd }) ?? true;
  }

  async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult> {
    const hookInput = createHookInput(input.event, input.baseInput, input.payload);
    const hookResult = await this.hooks.run({
      event: input.event,
      hookInput,
      matchQuery: input.matchQuery,
      cwd: input.baseInput.cwd,
      env: input.env,
      signal: input.signal,
    });

    return {
      effects: hookResult.effects,
      messages: createMessagesFromEffects(hookResult.effects),
      events: hookResult.events,
      blockingErrors: hookResult.blockingErrors,
      nonBlockingErrors: hookResult.nonBlockingErrors,
    };
  }
}

export class NullLifecycleRuntime extends LifecycleRuntime {
  constructor() {
    super(new HookRuntime({}));
  }

  override async dispatch(): Promise<LifecycleDispatchResult> {
    return emptyLifecycleDispatchResult();
  }

  override hasHooks(): boolean { return this.dispatch !== NullLifecycleRuntime.prototype.dispatch; }
}

/** Matching hooks may execute arbitrary workspace commands, including on read-only tools. */
export async function dispatchWithWorkspaceProtection(
  runtime: LifecycleRuntime | undefined, input: LifecycleDispatchInput, ready?: () => Promise<void>, ignoreHookErrors = false,
): Promise<LifecycleDispatchResult> {
  if (!runtime) return emptyLifecycleDispatchResult();
  if (ready && runtime.hasHooks?.(input) !== false) await ready();
  try { return await runtime.dispatch(input); }
  catch (error) { if (!ignoreHookErrors) throw error; return emptyLifecycleDispatchResult(); }
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
        metadata: { synthetic: true, purpose: "hook_context" },
      });
    }
  }
  return messages;
}
