import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { ripgrepFiles } from "./filesystem/ripgrepFiles.js";

export type GlobInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string;
  relativePattern: string;
} {
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) {
    return {
      baseDir: path.dirname(pattern),
      relativePattern: path.basename(pattern),
    };
  }

  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf("/"),
    staticPrefix.lastIndexOf(path.sep),
  );

  if (lastSepIndex === -1) {
    return { baseDir: "", relativePattern: pattern };
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex);
  const relativePattern = pattern.slice(lastSepIndex + 1);

  if (baseDir === "" && lastSepIndex === 0) {
    baseDir = "/";
  }
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = `${baseDir}${path.sep}`;
  }

  return { baseDir, relativePattern };
}

export function createGlobTool(): PilotDeckToolDefinition<GlobInput> {
  return {
    name: "glob",
    aliases: ["Glob"],
    description:
      "Fast file pattern matching tool scoped to the workspace.\n\nUsage:\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\".\n- Use this tool when you need to find files by name patterns.\n- Provide the optional path parameter to restrict the search to a subdirectory inside the workspace.\n- Returns matching file paths in stable sorted order.\n- Use this tool to narrow down candidate files before reading or editing them.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description:
            "The glob pattern to match files against. May be workspace-relative, path-relative, "
            + "or an absolute glob that resolves inside the workspace.",
        },
        path: {
          type: "string",
          description:
            "The directory to search in. If not specified, the workspace root will be used. Omit this field to use the default directory. Must resolve to a directory inside the workspace if provided.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of file paths to return. This is a PilotDeck-specific output cap; defaults to 1000. Results remain stable and sorted before truncation.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      let searchPath = input.path ?? ".";
      let searchPattern = input.pattern;

      if (path.isAbsolute(input.pattern)) {
        const extracted = extractGlobBaseDirectory(input.pattern);
        if (extracted.baseDir) {
          searchPath = extracted.baseDir;
          searchPattern = extracted.relativePattern;
        }
      }

      const resolvedSearchPath = resolvePilotDeckWorkspacePath(
        searchPath,
        context,
        { mustExist: true },
      );
      if (!resolvedSearchPath.ok) {
        throw new PilotDeckToolRuntimeError(
          resolvedSearchPath.error.code,
          resolvedSearchPath.error.message,
          resolvedSearchPath.error.details,
        );
      }

      const result = await ripgrepFiles({
        cwd: resolvedSearchPath.absolutePath,
        pattern: searchPattern,
        limit: input.limit,
        env: context.env,
        signal: context.abortSignal,
      });
      const workspacePrefix = resolvedSearchPath.relativePath === "." ? "" : `${resolvedSearchPath.relativePath}/`;
      const workspaceFiles = result.files.map((file) => `${workspacePrefix}${file}`);

      return {
        content: [{ type: "text", text: formatGlobResult(workspaceFiles, result.count, result.truncated, input.limit) }],
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

function formatGlobResult(files: string[], totalCount: number, truncated: boolean, limit: number | undefined): string {
  const lines = files.length > 0 ? [...files] : ["[No files matched]"];
  lines.push("", `[glob pagination] returned=${files.length} total=${totalCount} truncated=${truncated}${limit !== undefined ? ` limit=${limit}` : ""}`);
  if (truncated) {
    lines.push("More files are available. Narrow the pattern/path or call glob again with a higher limit if you need the full list.");
  }
  return lines.join("\n");
}
