import { chmod, link, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";
import { resolveRealWritePath } from "./pathSafety.js";

export async function writeTextFile(
  filePath: string,
  content: string,
  options?: { allowOverwrite?: boolean },
): Promise<"created" | "overwritten"> {
  // Publish to the authorized physical target, never replace a file symlink.
  const target = resolveRealWritePath(filePath);
  if (!target) throw new PilotDeckToolRuntimeError("file_conflict", `Cannot resolve ${filePath}.`);
  filePath = target;
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
  const temporary = path.join(path.dirname(filePath), `.pilotdeck-restore-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: existing?.mode ?? 0o644 });
    if (existing) await chmod(temporary, existing.mode);
    if (existing) await rename(temporary, filePath);
    else await link(temporary, filePath);
  } finally { await unlink(temporary).catch(() => {}); }
  return existing ? "overwritten" : "created";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
