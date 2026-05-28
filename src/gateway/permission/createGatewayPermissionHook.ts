import { randomUUID } from "node:crypto";
import type { CallbackHookHandler } from "../../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookSyncOutput } from "../../extension/hooks/protocol/output.js";
import type { PermissionRule } from "../../permission/protocol/types.js";
import type { GatewayEvent } from "../protocol/types.js";
import type { GatewayPermissionBus, GatewayPermissionDecision } from "./GatewayPermissionBus.js";

export const GATEWAY_PERMISSION_CALLBACK_NAME = "pilotdeck.gateway.permission";

export type CreateGatewayPermissionHookOptions = {
  /** PilotDeck session this hook owns. Used to scope bus pending entries. */
  sessionKey: string;
  /** Shared permission bus where decisions arrive from the Web UI. */
  bus: GatewayPermissionBus;
  /**
   * Pump a {@link GatewayEvent} into the active `submitTurn` stream so the
   * Web UI sees a `permission_request` event and can show a banner.
   * Returns true when the event was delivered, false when no active turn
   * sink exists (in which case the hook auto-denies — there's nowhere to
   * surface the prompt).
   */
  emit: (event: GatewayEvent) => boolean;
  /**
   * Live `permissionRules.allow` array shared with the session's
   * `PermissionContext`. When the user grants with `remember=true` the
   * hook pushes a session-scoped allow rule here so subsequent calls to
   * the same tool inside this session short-circuit the ask path.
   */
  permissionRules: PermissionRule[];
  /** Inject a deterministic UUID for tests. */
  uuid?: () => string;
};

/**
 * Build a callback hook handler that bridges the agent's PermissionRequest
 * lifecycle event to the Web UI's permission banner. The full round-trip:
 *
 *   1. `ToolRuntime.runTool()` decides `ask` for an un-whitelisted tool.
 *   2. `dispatchLifecycle("PermissionRequest", ...)` runs the registered
 *      callback hook (this handler).
 *   3. Handler emits a `permission_request` GatewayEvent into the
 *      active `submitTurn` queue, mints a `requestId`, and parks itself
 *      on a Promise registered with the GatewayPermissionBus.
 *   4. The Web UI's banner fires `permissionDecide(requestId, allow/deny,
 *      remember)`, which the gateway routes to `bus.consume(...)`, which
 *      resolves the Promise.
 *   5. If `decision.remember && allow`, push a session-scoped allow rule
 *      into the shared `permissionRules` array so the live
 *      PermissionContext picks it up on the very next decide() call —
 *      no need to wait for the next turn to re-sync from the frontend.
 *   6. Return a hook output containing `specific.decision`, which the
 *      HookRuntime turns into a `permission_request_result` effect that
 *      ToolRuntime maps back into an allow/deny final decision.
 *
 * If there's no active submit-turn sink for the session (which would
 * mean nobody can see the banner), the hook denies immediately — better
 * a clean denial than a silent hang.
 */
export function createGatewayPermissionHook(
  options: CreateGatewayPermissionHookOptions,
): CallbackHookHandler {
  return async ({ hookInput, signal }) => {
    const toolName = typeof hookInput.toolName === "string" ? hookInput.toolName : "UnknownTool";
    const toolCallId = typeof hookInput.toolCallId === "string" ? hookInput.toolCallId : "";
    const payload = "input" in hookInput ? hookInput.input : hookInput;
    const requestId = options.uuid ? options.uuid() : randomUUID();

    const delivered = options.emit({
      type: "permission_request",
      requestId,
      toolName,
      payload,
    });

    if (!delivered) {
      return {
        type: "sync",
        specific: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Permission prompt could not be delivered to the Web UI.",
          },
        },
      } satisfies PilotDeckHookSyncOutput;
    }

    let onAbort: (() => void) | undefined;
    const decision = await new Promise<GatewayPermissionDecision>((resolve, reject) => {
      options.bus.register(options.sessionKey, {
        requestId,
        toolCallId,
        toolName,
        resolve,
        reject,
      });
      if (signal) {
        if (signal.aborted) {
          reject(new Error("Hook aborted before permission decision."));
          return;
        }
        onAbort = () => reject(new Error("Hook aborted before permission decision."));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }).finally(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    });

    if (decision.decision === "allow" && decision.remember) {
      // Mutate the live array shared with PermissionContext.rules.allow
      // so the next tool.checkPermissions() / decide() in this same turn
      // walks the allow branch instead of asking again.
      const alreadyAllowed = options.permissionRules.some(
        (rule) => rule.behavior === "allow" && rule.toolName === toolName,
      );
      if (!alreadyAllowed) {
        options.permissionRules.push({
          source: "session",
          behavior: "allow",
          toolName,
        });
      }
    }

    return {
      type: "sync",
      specific: {
        hookEventName: "PermissionRequest",
        decision:
          decision.decision === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: decision.reason },
      },
    } satisfies PilotDeckHookSyncOutput;
  };
}
