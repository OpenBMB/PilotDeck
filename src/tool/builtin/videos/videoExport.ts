import { copyFile, link, mkdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname } from "node:path";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import { resolvePilotDeckWorkspacePath } from "../filesystem/pathSafety.js";
import { withFileMutation } from "../filesystem/coordinateMutation.js";
import type { GeneratedVideo } from "./VideoStore.js";
export function outputPath(path: string, context: PilotDeckToolRuntimeContext): string {
  const resolved = resolvePilotDeckWorkspacePath(path, context, { forWrite: true });
  if (!resolved.ok) throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message);
  if (extname(path).toLowerCase() !== ".mp4") throw new PilotDeckToolRuntimeError("invalid_tool_input", "Output path must end in .mp4.");
  return resolved.absolutePath;
}
export async function publish(video: GeneratedVideo, path: string, context: PilotDeckToolRuntimeContext): Promise<string> {
  const target = outputPath(path, context);
  return withFileMutation(context, target, async () => {
    outputPath(path, context); context.abortSignal?.throwIfAborted();
    await context.fileHistory?.trackEdit(target, context.messageId ?? context.turnId);
    await mkdir(dirname(target), { recursive: true }); const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(video.path, staging, constants.COPYFILE_EXCL); context.abortSignal?.throwIfAborted();
      await link(staging, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PilotDeckToolRuntimeError("file_conflict", "The output file already exists. Choose a new path.");
      throw error;
    } finally { await unlink(staging).catch(() => {}); }
    await context.fileHistory?.recordEdit?.(target, context.messageId ?? context.turnId); return target;
  });
}
