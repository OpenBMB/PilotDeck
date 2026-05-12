import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../tool/index.js";
import { matchPermissionRule } from "../policy/matchPermissionRule.js";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionRequest,
  PermissionResult,
  PermissionRule,
} from "../protocol/types.js";

export class PermissionRuntime {
  async decide(
    tool: PilotDeckToolDefinition,
    input: unknown,
    context: PilotDeckToolRuntimeContext,
    toolCallId: string,
  ): Promise<PermissionDecision> {
    const permissionContext = context.permissionContext;

    const denyRule = findMatchingRule(permissionContext.rules.deny, tool.name);
    if (denyRule) {
      return denyFromRule(denyRule);
    }

    const askRule = findMatchingRule(permissionContext.rules.ask, tool.name);
    if (askRule) {
      return finalizeAsk(askFromRule(tool, input, toolCallId, askRule), permissionContext);
    }

    // Check user-configured allow rules BEFORE consulting the tool's own
    // checkPermissions, so an explicit "Allow + remember" grant wins
    // over a tool that hardcodes ask (web_fetch / web_search do this).
    // Without this ordering, the user's grant is effectively ignored:
    // tool.checkPermissions returns ask → runtime surfaces another
    // permission prompt → next call repeats → infinite prompts.
    // Deny rules (checked above) still win over allow rules.
    const allowRule = findMatchingRule(permissionContext.rules.allow, tool.name);
    if (allowRule) {
      return allow({
        type: "rule",
        behavior: "allow",
        rule: allowRule,
        message: `Allow rule permits ${tool.name}.`,
      });
    }

    const toolPermission = await tool.checkPermissions?.(input, context);
    const toolDecision = normalizeToolPermission(toolPermission, tool, input, toolCallId, permissionContext);
    if (toolDecision) {
      if (toolDecision.type === "ask") {
        return finalizeAsk(toolDecision, permissionContext);
      }
      return toolDecision;
    }

    if (
      permissionContext.mode === "bypassPermissions" ||
      (permissionContext.mode === "plan" && permissionContext.bypassAvailable)
    ) {
      return allow({
        type: "mode",
        mode: permissionContext.mode,
        message: `Permission mode ${permissionContext.mode} allows ${tool.name}.`,
      });
    }

    const modeDecision = decideByMode(tool, input, toolCallId, permissionContext);
    return modeDecision.type === "ask" ? finalizeAsk(modeDecision, permissionContext) : modeDecision;
  }
}

function normalizeToolPermission(
  result: PermissionResult | undefined,
  tool: PilotDeckToolDefinition,
  input: unknown,
  toolCallId: string,
  context: PermissionContext,
): PermissionDecision | undefined {
  if (!result || result.type === "passthrough") {
    return undefined;
  }

  if (result.type === "ask") {
    return {
      ...result,
      request: {
        ...result.request,
        toolCallId,
        toolName: tool.name,
      },
    };
  }

  if (result.type === "allow" || result.type === "deny" || result.type === "cancel") {
    return result;
  }

  return ask(tool, input, toolCallId, {
    type: "runtime",
    message: `Permission result for ${tool.name} was not recognized in mode ${context.mode}.`,
  });
}

function decideByMode(
  tool: PilotDeckToolDefinition,
  input: unknown,
  toolCallId: string,
  context: PermissionContext,
): PermissionDecision {
  if (context.mode === "plan") {
    if (tool.isReadOnly(input)) {
      return allow({
        type: "mode",
        mode: "plan",
        message: `Plan mode allows read-only tool ${tool.name}.`,
      });
    }

    return deny({
      type: "mode",
      mode: "plan",
      message: `Plan mode denies side-effecting tool ${tool.name}.`,
    });
  }

  if (context.mode === "acceptEdits" && tool.kind === "filesystem" && !tool.isReadOnly(input)) {
    return allow({
      type: "mode",
      mode: "acceptEdits",
      message: `acceptEdits allows filesystem edit tool ${tool.name}.`,
    });
  }

  if (tool.isReadOnly(input)) {
    return allow({
      type: "mode",
      mode: context.mode,
      message: `Mode ${context.mode} allows read-only tool ${tool.name}.`,
    });
  }

  return ask(tool, input, toolCallId, {
    type: "mode",
    mode: context.mode,
    message: `Mode ${context.mode} requires permission for ${tool.name}.`,
  });
}

function findMatchingRule(rules: PermissionRule[], toolName: string): PermissionRule | undefined {
  return rules.find((rule) => matchPermissionRule(rule, toolName));
}

function allow(reason: PermissionDecisionReason): PermissionDecision {
  return { type: "allow", reason };
}

function deny(reason: PermissionDecisionReason): PermissionDecision {
  return { type: "deny", reason, message: reason.message };
}

function denyFromRule(rule: PermissionRule): PermissionDecision {
  return deny({
    type: "rule",
    behavior: "deny",
    rule,
    message: `Deny rule blocks ${rule.toolName}.`,
  });
}

function askFromRule(
  tool: PilotDeckToolDefinition,
  input: unknown,
  toolCallId: string,
  rule: PermissionRule,
): PermissionDecision {
  return ask(tool, input, toolCallId, {
    type: "rule",
    behavior: "ask",
    rule,
    message: `Ask rule requires confirmation for ${tool.name}.`,
  });
}

function ask(
  tool: PilotDeckToolDefinition,
  input: unknown,
  toolCallId: string,
  reason: PermissionDecisionReason,
): PermissionDecision {
  return {
    type: "ask",
    reason,
    request: createPermissionRequest(tool, input, toolCallId, reason),
  };
}

function createPermissionRequest(
  tool: PilotDeckToolDefinition,
  input: unknown,
  toolCallId: string,
  reason: PermissionDecisionReason,
): PermissionRequest {
  return {
    toolCallId,
    toolName: tool.name,
    inputSummary: summarizeInput(input),
    reason,
    options: [
      { id: "allow_once", label: "Allow once" },
      { id: "deny", label: "Deny" },
      { id: "cancel", label: "Cancel" },
    ],
  };
}

function finalizeAsk(decision: PermissionDecision, context: PermissionContext): PermissionDecision {
  if (decision.type !== "ask") {
    return decision;
  }

  if (context.mode === "dontAsk") {
    return {
      type: "deny",
      reason: {
        type: "mode",
        mode: "dontAsk",
        message: "dontAsk mode denies permission prompts.",
      },
      message: "Permission prompt denied because dontAsk mode is active.",
    };
  }

  return decision;
}

function summarizeInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (!json) {
      return String(input);
    }
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    return "[unserializable input]";
  }
}
