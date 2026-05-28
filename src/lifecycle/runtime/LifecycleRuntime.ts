import type { CanonicalMessage } from "../../model/index.js";
import { HookRuntime } from "../../extension/hooks/execution/HookRuntime.js";
import { createHookInput } from "../../extension/hooks/protocol/input.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "../protocol/payloads.js";
import { emptyLifecycleDispatchResult } from "../protocol/payloads.js";

export class LifecycleRuntime {
  constructor(private readonly hooks = new HookRuntime()) {}

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
