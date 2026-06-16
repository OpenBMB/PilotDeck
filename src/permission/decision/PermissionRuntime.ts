import { isAbsolute, relative, resolve } from "node:path";
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
    const sessionAllowRule = findMatchingRule(
      permissionContext.rules.allow.filter((rule) => rule.source === "session"),
      tool.name,
      input,
    );

    const denyRule = findMatchingRule(permissionContext.rules.deny, tool.name, input);
    if (denyRule) {
      if (sessionAllowRule && denyRule.source === "user") {
        return this.allowSessionRule(tool, input, context, toolCallId, sessionAllowRule);
      }
      return denyFromRule(denyRule);
    }

    const askRule = findMatchingRule(permissionContext.rules.ask, tool.name, input);
    if (askRule) {
      return finalizeAsk(askFromRule(tool, input, toolCallId, askRule), permissionContext);
    }

    if (sessionAllowRule) {
      return this.allowSessionRule(tool, input, context, toolCallId, sessionAllowRule);
    }

    // Check user-configured allow rules BEFORE consulting the tool's own
    // checkPermissions, so an explicit "Allow + remember" grant wins
    // over a tool that hardcodes ask (web_fetch / web_search do this).
    // Without this ordering, the user's grant is effectively ignored:
    // tool.checkPermissions returns ask → runtime surfaces another
    // permission prompt → next call repeats → infinite prompts.
    // Deny rules (checked above) still win over allow rules.
    const allowRule = findMatchingRule(permissionContext.rules.allow, tool.name, input);
    if (allowRule) {
      // Plan mode deny takes precedence over user allow rules for
      // non-readonly tools (except plan-directory markdown writes). Without this guard,
      // a user who previously allowed write_file/bash can inadvertently
      // bypass plan mode's read-only constraint.
      if (
        permissionContext.mode === "plan" &&
        !tool.isReadOnly(input) &&
        !isPlanDirectoryWrite(tool, input, permissionContext)
      ) {
        // Fall through to mode-level deny below.
      } else {
        return allow({
          type: "rule",
          behavior: "allow",
          rule: allowRule,
          message: `Allow rule permits ${tool.name}.`,
        });
      }
    }

    const toolPermission = await tool.checkPermissions?.(input, context);
    const toolDecision = normalizeToolPermission(toolPermission, tool, input, toolCallId, permissionContext);
    if (toolDecision) {
      if (toolDecision.type === "ask") {
        // `bypassPermissions` mode is the user's explicit "approve
        // everything" escape hatch. Tools that hardcode `ask` in
        // `checkPermissions` (web_search, web_fetch, agent dispatch,
        // mcp tools, …) would otherwise still prompt — defeating the
        // mode's whole purpose. Treat the tool's `ask` the same way
        // we'd treat a missing `checkPermissions` and fall through
        // to mode-level allow. User-configured `ask` rules already
        // short-circuited above, so they aren't affected. Tool-level
        // `deny` (safety regex etc.) is handled below and still wins.
        if (permissionContext.mode === "bypassPermissions") {
          return allow({
            type: "mode",
            mode: permissionContext.mode,
            message: `Permission mode ${permissionContext.mode} overrides ${tool.name}.checkPermissions ask.`,
          });
        }
        if (permissionContext.mode === "plan" && tool.isReadOnly(input)) {
          return allow({
            type: "mode",
            mode: "plan",
            message: `Plan mode allows read-only tool ${tool.name} despite .checkPermissions ask.`,
          });
        }
        if (permissionContext.mode === "plan" && !isPlanDirectoryWrite(tool, input, permissionContext)) {
          return deny({
            type: "mode",
            mode: "plan",
            message: buildPlanModeSideEffectDenyMessage(tool.name),
          });
        }
        return finalizeAsk(toolDecision, permissionContext);
      }
      return toolDecision;
    }

    if (permissionContext.mode === "bypassPermissions") {
      return allow({
        type: "mode",
        mode: permissionContext.mode,
        message: `Permission mode ${permissionContext.mode} allows ${tool.name}.`,
      });
    }

    const modeDecision = decideByMode(tool, input, toolCallId, permissionContext);
    return modeDecision.type === "ask" ? finalizeAsk(modeDecision, permissionContext) : modeDecision;
  }

  private async allowSessionRule(
    tool: PilotDeckToolDefinition,
    input: unknown,
    context: PilotDeckToolRuntimeContext,
    toolCallId: string,
    rule: PermissionRule,
  ): Promise<PermissionDecision> {
    const toolPermission = await tool.checkPermissions?.(input, context);
    const toolDecision = normalizeToolPermission(toolPermission, tool, input, toolCallId, context.permissionContext);
    if (toolDecision && toolDecision.type !== "ask") {
      return toolDecision;
    }
    return allow({
      type: "rule",
      behavior: "allow",
      rule,
      message: `Session allow rule permits ${tool.name}.`,
    });
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

    if (isPlanDirectoryWrite(tool, input, context)) {
      return allow({
        type: "mode",
        mode: "plan",
        message: `Plan mode allows writing markdown plans under the plan directory.`,
      });
    }

    return deny({
      type: "mode",
      mode: "plan",
      message: buildPlanModeSideEffectDenyMessage(tool.name),
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

function findMatchingRule(rules: PermissionRule[], toolName: string, input: unknown): PermissionRule | undefined {
  return rules.find((rule) => matchPermissionRule(rule, toolName, input));
}

function allow(reason: PermissionDecisionReason): PermissionDecision {
  return { type: "allow", reason };
}

function deny(reason: PermissionDecisionReason): PermissionDecision {
  return { type: "deny", reason, message: reason.message };
}

function buildPlanModeSideEffectDenyMessage(toolName: string): string {
  return [
    `Plan mode denies side-effecting tool ${toolName}.`,
    "You are still in plan mode. Continue with read-only exploration and analysis, refine or write the markdown plan under `.pilotdeck/plans/`, then submit it with `exit_plan_mode` when the plan is concrete and actionable.",
  ].join(" ");
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

  if (context.mode === "bypassPermissions") {
    return {
      type: "allow",
      reason: {
        type: "mode",
        mode: "bypassPermissions",
        message: "bypassPermissions mode skips permission prompts.",
      },
    };
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

/**
 * Returns true when a filesystem write tool (write_file / edit_file) targets
 * a markdown file under the project-local `.pilotdeck/plans` directory.
 * Resolves relative paths against the permission context cwd so `./foo.md`
 * and the absolute path both match.
 */
function isPlanDirectoryWrite(
  tool: PilotDeckToolDefinition,
  input: unknown,
  context: PermissionContext,
): boolean {
  if (tool.kind !== "filesystem" || !context.planDirectoryPath) return false;
  const record = input as Record<string, unknown> | null;
  const filePath = record?.file_path ?? record?.filePath;
  if (typeof filePath !== "string") return false;
  const absolute = resolve(context.cwd, filePath);
  if (!absolute.toLowerCase().endsWith(".md")) {
    return false;
  }
  const relativeToPlanDir = relative(context.planDirectoryPath, absolute);
  return (
    relativeToPlanDir !== ""
    && !isAbsolute(relativeToPlanDir)
    && !relativeToPlanDir.startsWith("..")
    && !relativeToPlanDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}
