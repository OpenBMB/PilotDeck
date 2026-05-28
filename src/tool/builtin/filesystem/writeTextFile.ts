import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";

export async function writeTextFile(
  filePath: string,
  content: string,
  options?: { allowOverwrite?: boolean },
): Promise<"created" | "overwritten"> {
  const existing = await stat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (existing && !existing.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${filePath} exists and is not a regular file.`);
  }

  if (existing && !options?.allowOverwrite) {
    throw new PilotDeckToolRuntimeError(
      "file_conflict",
      `${filePath} already exists. Set allow_overwrite to true to overwrite it.`,
    );
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return existing ? "overwritten" : "created";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
