import { stat } from "node:fs/promises";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";
import {
  buildStructuredPatch,
  buildUnifiedDiff,
  type StructuredPatchHunk,
} from "./filesystem/structuredPatch.js";
import {
  ensureWriteSnapshotFresh,
  invalidateReadFileState,
  recordWriteSnapshot,
  validateWriteSnapshotFresh,
} from "./filesystem/writeSnapshots.js";

export type WriteFileInput = {
  file_path: string;
  content: string;
};

export type WriteFileOutput = {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
  gitDiff?: {
    path: string;
    diff: string;
  };
};

export function createWriteFileTool(): PilotDeckToolDefinition<WriteFileInput, WriteFileOutput> {
  return {
    name: "write_file",
    aliases: ["Write"],
    description:
      "Writes a UTF-8 text file inside the workspace.\n\nUsage:\n- The file_path parameter may be relative to the current workspace or an absolute path, but it must resolve inside the workspace.\n- This tool will overwrite the existing file if there is one at the provided path.\n- You must read an existing file with read_file before writing to it. This tool will fail if you did not read the file first.\n- If the target file changed after the last read, this tool will fail and you must read it again before writing.\n- Prefer the edit_file tool for modifying existing files. Only use this tool to create new files or for complete rewrites.\n- The returned filePath is always the resolved absolute path.\n- Do not create documentation files (*.md) or README files unless explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "content"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description:
            "The path to the file to write. It may be relative to the current workspace or absolute, but it must resolve inside the workspace.",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["type", "filePath", "content", "structuredPatch", "originalFile"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["create", "update"] },
        filePath: { type: "string" },
        content: { type: "string" },
        structuredPatch: {
          type: "array",
          items: {
            type: "object",
            required: ["oldStart", "oldLines", "newStart", "newLines", "lines"],
            additionalProperties: false,
            properties: {
              oldStart: { type: "integer" },
              oldLines: { type: "integer" },
              newStart: { type: "integer" },
              newLines: { type: "integer" },
              lines: {
                type: "array",
                items: {
                  type: "object",
                  required: ["type", "text"],
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["context", "delete", "add"] },
                    text: { type: "string" },
                  },
                },
              },
            },
          },
        },
        originalFile: { type: ["string", "null"] },
        gitDiff: {
          type: "object",
          required: ["path", "diff"],
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            diff: { type: "string" },
          },
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    validateInput: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, { forWrite: true });
      if (!resolved.ok) {
        return {
          ok: false,
          issues: [{
            path: "file_path",
            code: "invalid_schema",
            message: resolved.error.message,
          }],
        };
      }

      try {
        await validateWriteSnapshotFresh(context, resolved.absolutePath);
      } catch (error) {
        const normalized = error instanceof PilotDeckToolRuntimeError ? error.message : String(error);
        if (normalized === "File has not been read yet. Read it first before writing to it."
          || normalized === "File has changed since the last read. Read it again before writing to it.") {
          return {
            ok: false,
            issues: [{
              path: "file_path",
              code: "invalid_schema",
              message: normalized,
            }],
          };
        }
        throw error;
      }

      return { ok: true, input };
    },
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, { forWrite: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const freshness = await ensureWriteSnapshotFresh(context, resolved.absolutePath);
      if (context.fileHistory) {
        await context.fileHistory.trackEdit(
          resolved.absolutePath,
          context.messageId ?? context.turnId,
        );
      }

      const action = await writeTextFile(resolved.absolutePath, input.content, { allowOverwrite: true });
      const fileStat = await stat(resolved.absolutePath);
      invalidateReadFileState(context, resolved.absolutePath);
      recordWriteSnapshot(context, resolved.absolutePath, input.content, Math.floor(fileStat.mtimeMs));

      const type = action === "created" ? "create" : "update";
      const structuredPatch = buildStructuredPatch(freshness.previousContent, input.content);
      const gitDiffText = buildUnifiedDiff(resolved.relativePath, freshness.previousContent, input.content);
      const data: WriteFileOutput = {
        type,
        filePath: resolved.absolutePath,
        content: input.content,
        structuredPatch,
        originalFile: freshness.previousContent,
        ...(gitDiffText ? { gitDiff: { path: resolved.relativePath, diff: gitDiffText } } : {}),
      };

      const update = {
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        root: resolved.root,
        content: input.content,
        previousContent: freshness.previousContent,
      };
      await context.fileUpdateNotifier?.didChange?.(update);
      await context.fileUpdateNotifier?.didSave?.(update);

      return {
        content: [{ type: "text", text: `${type === "create" ? "Created" : "Overwrote"} ${resolved.relativePath}.` }],
        data,
        metadata: {
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
          mtimeMs: Math.floor(fileStat.mtimeMs),
        },
      };
    },
  };
}
