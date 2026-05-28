import { readFile, stat } from "node:fs/promises";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { isNotebookPath } from "./filesystem/fileTypeSafety.js";
import { writeTextFile } from "./filesystem/writeTextFile.js";
import {
  ensureWriteSnapshotFresh,
  invalidateReadFileState,
  recordWriteSnapshot,
  validateWriteSnapshotFresh,
} from "./filesystem/writeSnapshots.js";

type NotebookCell = {
  id?: string;
  cell_type?: string;
  source?: string[] | string;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
};

type NotebookContent = {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: {
    language_info?: {
      name?: string;
    };
    [key: string]: unknown;
  };
  cells?: NotebookCell[];
  [key: string]: unknown;
};

export type EditNotebookInput = {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: "code" | "markdown";
  edit_mode?: "replace" | "insert" | "delete";
};

export type EditNotebookOutput = {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type: "code" | "markdown";
  language: string;
  edit_mode: "replace" | "insert" | "delete";
  original_file: string;
  updated_file: string;
  error?: string;
};

export function createEditNotebookTool(): PilotDeckToolDefinition<EditNotebookInput, EditNotebookOutput> {
  return {
    name: "edit_notebook",
    aliases: ["NotebookEdit"],
    description:
      "Edit a Jupyter notebook (.ipynb) by replacing, inserting, or deleting a specific cell.\n\nUsage:\n"
      + "- Use this tool for notebook cell edits instead of edit_file.\n"
      + "- notebook_path may be relative to the current workspace or absolute, but it must resolve inside the workspace.\n"
      + "- edit_mode defaults to replace and supports replace, insert, or delete.\n"
      + "- insert requires cell_type and inserts after the referenced cell, or at the beginning when cell_id is omitted.\n"
      + "- cell_id may be a real notebook cell id or a synthetic index in the form cell-N.\n"
      + "- You MUST use read_file on the notebook first; stale notebook edits are rejected.",
    kind: "filesystem",
    searchHint: "edit notebook cells in ipynb files",
    inputSchema: {
      type: "object",
      required: ["notebook_path", "new_source"],
      additionalProperties: false,
      properties: {
        notebook_path: {
          type: "string",
          description: "Relative or absolute path to the Jupyter notebook file.",
        },
        cell_id: {
          type: "string",
          description: "Notebook cell id, or a synthetic index in the form cell-N.",
        },
        new_source: {
          type: "string",
          description: "New source to write to the cell. Still required for delete to preserve legacy parity.",
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "Cell type for inserts, or an optional replacement type for replace.",
        },
        edit_mode: {
          type: "string",
          enum: ["replace", "insert", "delete"],
          description: "Notebook edit mode. Defaults to replace.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: [
        "notebook_path",
        "new_source",
        "cell_type",
        "language",
        "edit_mode",
        "original_file",
        "updated_file",
      ],
      additionalProperties: false,
      properties: {
        notebook_path: { type: "string" },
        cell_id: { type: "string" },
        new_source: { type: "string" },
        cell_type: { type: "string", enum: ["code", "markdown"] },
        language: { type: "string" },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
        original_file: { type: "string" },
        updated_file: { type: "string" },
        error: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    validateInput: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.notebook_path, context, { mustExist: true, forWrite: true });
      if (!resolved.ok) {
        return {
          ok: false,
          issues: [{
            path: "notebook_path",
            code: "invalid_schema",
            message: resolved.error.message,
          }],
        };
      }

      if (!isNotebookPath(resolved.absolutePath)) {
        return {
          ok: false,
          issues: [{
            path: "notebook_path",
            code: "invalid_schema",
            message: "File must be a Jupyter notebook (.ipynb file). Use edit_file for non-notebook files.",
          }],
        };
      }

      const editMode = input.edit_mode ?? "replace";
      if (editMode === "insert" && !input.cell_type) {
        return {
          ok: false,
          issues: [{
            path: "cell_type",
            code: "invalid_schema",
            message: "cell_type is required when edit_mode is insert.",
          }],
        };
      }

      try {
        await validateWriteSnapshotFresh(context, resolved.absolutePath);
      } catch (error) {
        const normalized = error instanceof PilotDeckToolRuntimeError ? error.message : String(error);
        if (
          normalized === "File has not been read yet. Read it first before writing to it."
          || normalized === "File has changed since the last read. Read it again before writing to it."
        ) {
          return {
            ok: false,
            issues: [{
              path: "notebook_path",
              code: "invalid_schema",
              message: normalized,
            }],
          };
        }
        throw error;
      }

      const raw = await readNotebookJson(resolved.absolutePath);
      const notebook = parseNotebook(raw);
      const cells = notebook.cells ?? [];
      if (!input.cell_id) {
        if (editMode === "insert") {
          return { ok: true, input };
        }
        return {
          ok: false,
          issues: [{
            path: "cell_id",
            code: "invalid_schema",
            message: "cell_id is required unless edit_mode is insert.",
          }],
        };
      }

      const located = locateCellIndex(cells, input.cell_id);
      if (!located.found) {
        const canAppendViaReplace = editMode === "replace" && located.parsedIndex === cells.length;
        if (!canAppendViaReplace) {
          return {
            ok: false,
            issues: [{
              path: "cell_id",
              code: "invalid_schema",
              message: `Cell ${input.cell_id} does not exist in the notebook.`,
            }],
          };
        }
      }

      return { ok: true, input };
    },
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.notebook_path, context, { mustExist: true, forWrite: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }
      if (!isNotebookPath(resolved.absolutePath)) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "File must be a Jupyter notebook (.ipynb file). Use edit_file for non-notebook files.",
        );
      }

      const freshness = await ensureWriteSnapshotFresh(context, resolved.absolutePath);
      if (context.fileHistory) {
        await context.fileHistory.trackEdit(
          resolved.absolutePath,
          context.messageId ?? context.turnId,
        );
      }

      const originalContent = freshness.previousContent ?? await readNotebookJson(resolved.absolutePath);
      const notebook = parseNotebook(originalContent);
      notebook.cells ??= [];
      const cells = notebook.cells;
      const requestedMode = input.edit_mode ?? "replace";
      const located = input.cell_id ? locateCellIndex(cells, input.cell_id) : { found: false, index: 0, parsedIndex: undefined };
      let cellIndex = input.cell_id ? located.index : 0;
      if (requestedMode === "insert" && input.cell_id) {
        cellIndex += 1;
      }

      let effectiveMode = requestedMode;
      let effectiveCellType = input.cell_type;
      if (effectiveMode === "replace" && cellIndex === cells.length) {
        effectiveMode = "insert";
        effectiveCellType ??= "code";
      }

      const language = notebook.metadata?.language_info?.name ?? "python";
      const supportsCellIds = supportsNotebookCellIds(notebook);
      const resultCellId = effectiveMode === "insert"
        ? (supportsCellIds ? createNotebookCellId() : input.cell_id)
        : input.cell_id;

      if (effectiveMode === "delete") {
        if (cellIndex < 0 || cellIndex >= cells.length) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `Cell ${input.cell_id ?? `cell-${cellIndex}`} does not exist in the notebook.`,
          );
        }
        cells.splice(cellIndex, 1);
      } else if (effectiveMode === "insert") {
        cells.splice(cellIndex, 0, createInsertedCell(effectiveCellType ?? "code", input.new_source, resultCellId));
      } else {
        const targetCell = cells[cellIndex];
        if (!targetCell) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `Cell ${input.cell_id ?? `cell-${cellIndex}`} does not exist in the notebook.`,
          );
        }
        targetCell.source = input.new_source;
        if (targetCell.cell_type === "code") {
          targetCell.execution_count = null;
          targetCell.outputs = [];
        }
        if (input.cell_type && input.cell_type !== targetCell.cell_type) {
          targetCell.cell_type = input.cell_type;
        }
      }

      const updatedContent = `${JSON.stringify(notebook, null, 1)}\n`;
      await writeTextFile(resolved.absolutePath, updatedContent, { allowOverwrite: true });
      const fileStat = await stat(resolved.absolutePath);
      invalidateReadFileState(context, resolved.absolutePath);
      recordWriteSnapshot(context, resolved.absolutePath, updatedContent, Math.floor(fileStat.mtimeMs));

      const update = {
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        root: resolved.root,
        content: updatedContent,
        previousContent: originalContent,
      };
      await context.fileUpdateNotifier?.didChange?.(update);
      await context.fileUpdateNotifier?.didSave?.(update);

      const output: EditNotebookOutput = {
        notebook_path: resolved.absolutePath,
        cell_id: resultCellId,
        new_source: input.new_source,
        cell_type: effectiveCellType ?? inferResultCellType(cells, cellIndex, effectiveMode),
        language,
        edit_mode: effectiveMode,
        original_file: originalContent,
        updated_file: updatedContent,
      };

      return {
        content: [{
          type: "text",
          text: buildNotebookResultText(resolved.relativePath, effectiveMode, resultCellId),
        }],
        data: output,
        metadata: {
          bytesWritten: Buffer.byteLength(updatedContent, "utf8"),
          mtimeMs: Math.floor(fileStat.mtimeMs),
        },
      };
    },
  };
}

async function readNotebookJson(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PilotDeckToolRuntimeError("file_not_found", `File ${filePath} does not exist.`);
    }
    throw error;
  });
}

function parseNotebook(raw: string): NotebookContent {
  try {
    return JSON.parse(raw) as NotebookContent;
  } catch (error) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "Notebook is not valid JSON.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function parseCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function locateCellIndex(
  cells: NotebookCell[],
  cellId: string,
): { found: boolean; index: number; parsedIndex?: number } {
  const byId = cells.findIndex((cell) => cell.id === cellId);
  if (byId !== -1) {
    return { found: true, index: byId };
  }
  const parsedIndex = parseCellId(cellId);
  if (parsedIndex !== undefined) {
    return {
      found: parsedIndex >= 0 && parsedIndex < cells.length,
      index: parsedIndex,
      parsedIndex,
    };
  }
  return { found: false, index: -1 };
}

function supportsNotebookCellIds(notebook: NotebookContent): boolean {
  const nbformat = notebook.nbformat ?? 0;
  const nbformatMinor = notebook.nbformat_minor ?? 0;
  return nbformat > 4 || (nbformat === 4 && nbformatMinor >= 5);
}

function createInsertedCell(
  cellType: "code" | "markdown",
  source: string,
  id: string | undefined,
): NotebookCell {
  if (cellType === "markdown") {
    return {
      cell_type: "markdown",
      id,
      source,
      metadata: {},
    };
  }
  return {
    cell_type: "code",
    id,
    source,
    metadata: {},
    execution_count: null,
    outputs: [],
  };
}

function inferResultCellType(
  cells: NotebookCell[],
  cellIndex: number,
  editMode: "replace" | "insert" | "delete",
): "code" | "markdown" {
  if (editMode === "delete") {
    return "code";
  }
  return cells[cellIndex]?.cell_type === "markdown" ? "markdown" : "code";
}

function createNotebookCellId(): string {
  return Math.random().toString(36).slice(2, 15);
}

function buildNotebookResultText(
  relativePath: string,
  editMode: "replace" | "insert" | "delete",
  cellId: string | undefined,
): string {
  const suffix = cellId ? ` ${cellId}` : "";
  switch (editMode) {
    case "insert":
      return `Inserted notebook cell${suffix} in ${relativePath}.`;
    case "delete":
      return `Deleted notebook cell${suffix} from ${relativePath}.`;
    default:
      return `Updated notebook cell${suffix} in ${relativePath}.`;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
