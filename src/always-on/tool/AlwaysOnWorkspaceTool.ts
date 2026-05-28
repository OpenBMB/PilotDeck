import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";
import type { WorkspaceStrategyId } from "../protocol/types.js";
import type { AlwaysOnRunContextRegistry } from "../runtime/AlwaysOnRunContextRegistry.js";

export type AlwaysOnWorkspaceInput = {
  strategy: "git-worktree" | "snapshot-copy" | "auto";
};

export type AlwaysOnWorkspaceOutput = {
  ok: true;
  strategy: WorkspaceStrategyId;
  cwd: string;
  reused: boolean;
};

export type CreateAlwaysOnWorkspaceToolOptions = {
  runContexts: AlwaysOnRunContextRegistry;
};

export const ALWAYS_ON_WORKSPACE_TOOL_NAME = "always_on_prepare_workspace";

export function createAlwaysOnWorkspaceTool(
  options: CreateAlwaysOnWorkspaceToolOptions,
): PilotDeckToolDefinition<AlwaysOnWorkspaceInput, AlwaysOnWorkspaceOutput> {
  return {
    name: ALWAYS_ON_WORKSPACE_TOOL_NAME,
    aliases: ["AlwaysOnPrepareWorkspace"],
    description:
      "Prepare an isolated workspace for the current Always-On plan execution. " +
      "Use `auto` to let the runtime pick the best strategy, or specify `git-worktree` / `snapshot-copy` explicitly.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["strategy"],
      additionalProperties: false,
      properties: {
        strategy: {
          type: "string",
          enum: ["git-worktree", "snapshot-copy", "auto"],
          description: "Workspace isolation strategy.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const ctx = options.runContexts.getWorkspace(context.sessionId);
      if (!ctx) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `${ALWAYS_ON_WORKSPACE_TOOL_NAME} called outside of an Always-On workspace turn.`,
        );
      }
      if (ctx.handle) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          "workspace_already_prepared: a workspace was already created for this run.",
        );
      }

      let prepared: Awaited<ReturnType<typeof ctx.workspaceRegistry.prepare>>;
      if (input.strategy === "auto") {
        prepared = await ctx.workspaceRegistry.prepare({
          projectRoot: ctx.projectKey,
          runId: ctx.runId,
        });
      } else {
        const provider = ctx.workspaceRegistry.findById(input.strategy);
        if (!provider) {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            `workspace strategy "${input.strategy}" is not available.`,
          );
        }
        const handle = await provider.prepare({
          projectRoot: ctx.projectKey,
          runId: ctx.runId,
        });
        prepared = { handle, provider };
      }

      ctx.handle = prepared.handle;

      const data: AlwaysOnWorkspaceOutput = {
        ok: true,
        strategy: prepared.handle.strategy,
        cwd: prepared.handle.cwd,
        reused: false,
      };
      return {
        content: [
          { type: "text", text: `Workspace prepared at ${prepared.handle.cwd} (${prepared.handle.strategy}).` },
          { type: "json", value: data },
        ],
        data,
        metadata: { runId: ctx.runId },
      };
    },
  };
}
