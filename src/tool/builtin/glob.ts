import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { ripgrepFiles } from "./filesystem/ripgrepFiles.js";

export type GlobInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

export function createGlobTool(): PilotDeckToolDefinition<GlobInput> {
  return {
    name: "glob",
    aliases: ["Glob"],
    description:
      "Find workspace files matching a glob pattern.\n\nUsage:\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\".\n- Use this tool when you need to find files by name or wildcard pattern.\n- Provide the optional path parameter to restrict the search to a subdirectory.\n- Use this tool to narrow down candidate files before reading or editing them.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against.",
        },
        path: {
          type: "string",
          description:
            "The directory to search in. If not specified, the workspace root will be used. Must resolve to a directory inside the workspace if provided.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of file paths to return. This is a PilotDeck-specific output cap; defaults to 1000.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.path ?? ".", context, { mustExist: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const result = await ripgrepFiles({
        cwd: resolved.absolutePath,
        pattern: input.pattern,
        limit: input.limit,
        env: context.env,
        signal: context.abortSignal,
      });
      const workspacePrefix = resolved.relativePath === "." ? "" : `${resolved.relativePath}/`;
      const workspaceFiles = result.files.map((file) => `${workspacePrefix}${file}`);

      return {
        content: [{ type: "text", text: workspaceFiles.join("\n") }],
        data: {
          files: workspaceFiles,
          count: result.count,
          truncated: result.truncated,
        },
        metadata: { truncated: result.truncated },
      };
    },
  };
}
