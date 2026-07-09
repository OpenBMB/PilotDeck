import { stat } from "node:fs/promises";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { isNotebookPath } from "./filesystem/fileTypeSafety.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { checkFilesystemWritePermission } from "./filesystem/writePermissions.js";
import { readTextFile } from "./filesystem/readTextFile.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";
import {
  ensureWriteSnapshotFresh,
  invalidateReadFileState,
  recordWriteSnapshot,
  validateWriteSnapshotFresh,
} from "./filesystem/writeSnapshots.js";
import { findActualString, normalizeEditInput } from "./filesystem/editNormalization.js";
import { formatSyntaxDiagnostics } from "./filesystem/syntaxDiagnostics.js";

export type EditFileInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export function createEditFileTool(): PilotDeckToolDefinition<EditFileInput> {
  return {
    name: "edit_file",
    aliases: ["Edit"],
    description:
      "Edit a workspace text file, or an outside-workspace text file after explicit host permission, by replacing an exact string match.\n\nUsage:\n- You may create a new file directly by setting old_string to an empty string.\n- You must read an existing target file with read_file before editing it. This tool will reject edits to existing files that have not been read in this session.\n- old_string must exactly match the file content character-by-character, including indentation. Copy old_string directly from read_file output without adding or removing spaces.\n- Use this tool for targeted changes to an existing file.\n- old_string must appear in the target file unless you are creating a new file with old_string: \"\".\n- If old_string is not unique, either provide a more specific old_string or set replace_all to update every occurrence.\n- Use replace_all when renaming or replacing repeated text across the same file.\n- Paths outside the workspace require explicit user permission before execution.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description: "Relative or absolute path of the file to edit. Paths outside the workspace require explicit user permission.",
        },
        old_string: {
          type: "string",
          description: "The exact substring to find and replace. It must appear in the target file.",
        },
        new_string: {
          type: "string",
          description: "The replacement string that will replace old_string.",
        },
        replace_all: {
          type: "boolean",
          description:
            "When true, replace all occurrences of old_string. Defaults to false, which requires old_string to be unique.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    checkPermissions: async (input, context) =>
      checkFilesystemWritePermission("edit_file", input.file_path, context),
    validateInput: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, {
        forWrite: true,
        allowOutsideWorkspace: true,
      });
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

      if (isNotebookPath(resolved.absolutePath)) {
        return {
          ok: false,
          issues: [{
            path: "file_path",
            code: "invalid_schema",
            message: "File is a Jupyter notebook. Use edit_notebook to edit this file.",
          }],
        };
      }

      if (input.old_string !== "" && input.old_string === input.new_string) {
        return {
          ok: false,
          issues: [{
            path: "new_string",
            code: "invalid_schema",
            message: "old_string and new_string must differ.",
          }],
        };
      }

      let freshness: { exists: boolean };
      try {
        freshness = await validateWriteSnapshotFresh(context, resolved.absolutePath);
      } catch (error) {
        const normalized = error instanceof PilotDeckToolRuntimeError ? error.message : String(error);
        if (
          normalized === "File has not been read yet. Read it first before writing to it."
          || normalized === "File has changed since the last read. Read it again before writing to it."
        ) {
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

      if (!freshness.exists) {
        if (input.old_string === "") {
          return { ok: true, input };
        }
        return {
          ok: false,
          issues: [{
            path: "file_path",
            code: "invalid_schema",
            message: `File ${input.file_path} does not exist.`,
          }],
        };
      }

      if (input.old_string !== "") {
        return { ok: true, input };
      }

      const content = await readTextFile(resolved.absolutePath);
      if (content.length === 0) {
        return { ok: true, input };
      }

      return {
        ok: false,
        issues: [{
          path: "old_string",
          code: "invalid_schema",
          message: "old_string may be empty only when creating a new file or writing to an empty file.",
        }],
      };
    },
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, {
        forWrite: true,
        allowOutsideWorkspace: context.currentPermissionDecision?.type === "allow",
      });
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

      const content = freshness.previousContent ?? "";
      let occurrences = 0;
      let nextContent: string;

      if (input.old_string === "") {
        if (freshness.exists && content.length !== 0) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            "old_string may be empty only when creating a new file or writing to an empty file.",
          );
        }
        nextContent = input.new_string;
      } else {
        const { oldString: normalizedOld, newString: normalizedNew } =
          normalizeEditInput(resolved.absolutePath, input.old_string, input.new_string);
        const actualOldString = findActualString(content, normalizedOld);
        if (!actualOldString) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `String to replace not found in file.\nString: ${input.old_string}`,
          );
        }
        occurrences = countOccurrences(content, actualOldString);
        if (occurrences > 1 && !input.replace_all) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `Found ${occurrences} matches of old_string. Set replace_all to true to replace all occurrences, or provide a more specific old_string.`,
          );
        }
        nextContent = input.replace_all
          ? content.split(actualOldString).join(normalizedNew)
          : content.replace(actualOldString, normalizedNew);
      }

      const action = await writeTextFile(resolved.absolutePath, nextContent, { allowOverwrite: true });
      const fileStat = await stat(resolved.absolutePath);
      invalidateReadFileState(context, resolved.absolutePath);
      recordWriteSnapshot(context, resolved.absolutePath, nextContent, Math.floor(fileStat.mtimeMs));

      const update = {
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        root: resolved.root,
        content: nextContent,
        previousContent: freshness.previousContent,
      };
      await context.fileUpdateNotifier?.didChange?.(update);
      await context.fileUpdateNotifier?.didSave?.(update);

      const replacements = input.old_string === "" ? 0 : input.replace_all ? occurrences : 1;
      const successText =
        `${action === "created" ? "Created" : "Updated"} ${resolved.relativePath}${replacements > 0 ? ` (${replacements} replacement).` : "."}`;
      const syntaxDiagnostics = await formatSyntaxDiagnostics(resolved.relativePath, nextContent);
      return {
        content: [{
          type: "text",
          text: syntaxDiagnostics ? `${successText}\n\n${syntaxDiagnostics}` : successText,
        }],
        data: {
          filePath: resolved.relativePath,
          replacements,
          changed: action === "created" || nextContent !== content,
        },
        metadata: {
          bytesWritten: Buffer.byteLength(nextContent, "utf8"),
          mtimeMs: Math.floor(fileStat.mtimeMs),
        },
      };
    },
  };
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(search, index + search.length);
  }
  return count;
}
