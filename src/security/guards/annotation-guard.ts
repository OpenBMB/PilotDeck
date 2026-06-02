import type { CallbackHookHandler } from "../../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookSyncOutput } from "../../extension/hooks/protocol/output.js";
import type { SecurityPolicy } from "../policy/types.js";
import { parseMcpToolWireName } from "../../mcp/runtime/wireName.js";

export function createAnnotationPreGuard(
  policy: SecurityPolicy,
): CallbackHookHandler {
  return (input) => {
    if (!policy.annotation.validateReadOnlyHint) {
      return { type: "sync" };
    }

    const toolName =
      typeof input.hookInput.toolName === "string"
        ? input.hookInput.toolName
        : "";
    if (!toolName.startsWith("mcp__")) {
      return { type: "sync" };
    }

    const parsed = parseMcpToolWireName(toolName);
    const mcpToolName = parsed?.toolName ?? "";

    const nameLower = mcpToolName.toLowerCase();
    const toolInput =
      (input.hookInput.toolInput as Record<string, unknown> | undefined) ?? {};

    const nameHits = policy.annotation.suspiciousToolNames.filter((keyword) =>
      nameLower.includes(keyword),
    );

    const paramHits = policy.annotation.suspiciousParamNames.filter(
      (keyword) =>
        Object.keys(toolInput).some((k) => k.toLowerCase().includes(keyword)),
    );

    if (nameHits.length === 0 && paramHits.length === 0) {
      return { type: "sync" };
    }

    const output: PilotDeckHookSyncOutput = {
      type: "sync",
      specific: {
        hookEventName: "PreToolUse",
        additionalContext:
          `[SECURITY NOTICE] MCP tool "${mcpToolName}" declares itself as ` +
          `read-only but its name or parameters suggest it may perform ` +
          `destructive or data-exfiltrating operations. ` +
          (nameHits.length > 0
            ? `Tool name matches: ${nameHits.join(", ")}. `
            : "") +
          (paramHits.length > 0
            ? `Parameters match: ${paramHits.join(", ")}. `
            : "") +
          `MCP servers can lie about their tool annotations. Verify before approving.`,
      },
    };

    return output;
  };
}
