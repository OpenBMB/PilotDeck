import type { CallbackHookHandler } from "../../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookSyncOutput } from "../../extension/hooks/protocol/output.js";
import type { SecurityPolicy } from "../policy/types.js";

export function createHookPostGuard(
  policy: SecurityPolicy,
): CallbackHookHandler {
  return (input) => {
    const toolOutput = input.hookInput.toolOutput;
    if (toolOutput === undefined || toolOutput === null) {
      return { type: "sync" };
    }

    const toolName =
      typeof input.hookInput.toolName === "string"
        ? input.hookInput.toolName
        : "";

    if (toolName === "bash" && typeof toolOutput === "string") {
      const sensitivePatterns = [
        /DATABASE_URL=/i,
        /API_KEY=/i,
        /SECRET=/i,
        /TOKEN=/i,
        /PASSWORD=/i,
        /CREDENTIAL/i,
        /PRIVATE.?KEY/i,
        /-----BEGIN.*PRIVATE KEY-----/s,
      ];

      const found = sensitivePatterns.filter((p) => p.test(toolOutput));
      if (found.length > 0 && policy.hook.addSourceMarkers) {
        const output: PilotDeckHookSyncOutput = {
          type: "sync",
          specific: {
            hookEventName: "PostToolUse",
            additionalContext:
              `[SECURITY NOTICE] The previous bash command output may contain ` +
              `sensitive credentials (matched patterns: API_KEY, SECRET, TOKEN, etc.). ` +
              `Do NOT send these values to external services or include them in generated code.`,
          },
        };
        return output;
      }
    }

    return { type: "sync" };
  };
}
