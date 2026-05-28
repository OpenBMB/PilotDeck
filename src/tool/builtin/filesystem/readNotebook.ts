import { readFile } from "node:fs/promises";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";

type NotebookCell = {
  cell_type?: string;
  source?: string[] | string;
  outputs?: Array<{
    text?: string[] | string;
    data?: Record<string, unknown>;
    ename?: string;
    evalue?: string;
    traceback?: string[];
  }>;
  execution_count?: number | null;
};

type NotebookFile = {
  cells?: NotebookCell[];
};

export type NotebookReadResult = {
  text: string;
  cellCount: number;
};

export async function readNotebook(filePath: string): Promise<NotebookReadResult> {
  const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PilotDeckToolRuntimeError("file_not_found", `File ${filePath} does not exist.`);
    }
    throw error;
  });

  let notebook: NotebookFile;
  try {
    notebook = JSON.parse(raw) as NotebookFile;
  } catch (error) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Notebook ${filePath} is not valid JSON.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const cells = notebook.cells ?? [];
  const lines: string[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index] ?? {};
    lines.push(`# Cell ${index} (${cell.cell_type ?? "unknown"})`);
    if (cell.execution_count !== undefined && cell.execution_count !== null) {
      lines.push(`execution_count: ${cell.execution_count}`);
    }
    const source = normalizeMultiline(cell.source);
    if (source) {
      lines.push(source);
    }
    const outputs = formatOutputs(cell.outputs ?? []);
    if (outputs) {
      lines.push("## Outputs");
      lines.push(outputs);
    }
    if (index < cells.length - 1) {
      lines.push("");
    }
  }

  return {
    text: lines.join("\n"),
    cellCount: cells.length,
  };
}

function formatOutputs(outputs: NotebookCell["outputs"]): string {
  const chunks: string[] = [];
  for (const output of outputs ?? []) {
    const text = normalizeMultiline(output.text);
    if (text) {
      chunks.push(text);
      continue;
    }
    if (Array.isArray(output.traceback) && output.traceback.length > 0) {
      chunks.push(output.traceback.join("\n"));
      continue;
    }
    if (output.ename || output.evalue) {
      chunks.push(`${output.ename ?? "Error"}: ${output.evalue ?? ""}`.trim());
      continue;
    }
    const plain = output.data?.["text/plain"];
    const plainText = normalizeMultiline(plain as string[] | string | undefined);
    if (plainText) {
      chunks.push(plainText);
    }
  }
  return chunks.join("\n");
}

function normalizeMultiline(value: string[] | string | undefined): string {
  if (Array.isArray(value)) {
    return value.join("");
  }
  return typeof value === "string" ? value : "";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
