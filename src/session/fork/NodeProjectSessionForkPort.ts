import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import type { CanonicalContentBlock } from "../../model/index.js";
import { sanitizeSessionIdForPath } from "../storage/ProjectSessionStorage.js";
import { readCompactSnapshot } from "../transcript/CompactSnapshot.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type { ProjectSessionForkInput, ProjectSessionForkPort } from "./ProjectSessionForkPort.js";

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function retargetAuxiliaryPath(path: string, sourceSessionDir: string, targetSessionDir: string): string {
  const absolutePath = resolve(path);
  const relativePath = relative(sourceSessionDir, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return path;
  }
  return resolve(targetSessionDir, relativePath);
}

function retargetRelativeSessionPath(path: string, sourceSafeId: string, targetSafeId: string): string {
  const parts = path.split(/[\\/]/);
  if (parts[0] !== sourceSafeId) return path;
  return [targetSafeId, ...parts.slice(1)].join("/");
}

function retargetContentBlock(
  block: CanonicalContentBlock,
  sourceSessionDir: string,
  targetSessionDir: string,
): CanonicalContentBlock {
  if (block.type === "tool_result_reference" || block.type === "media_reference") {
    return {
      ...block,
      path: retargetAuxiliaryPath(block.path, sourceSessionDir, targetSessionDir),
    };
  }
  return block;
}

function retargetTranscriptEntryAuxiliaryPaths(
  entry: AgentTranscriptEntry,
  sourceSessionDir: string,
  targetSessionDir: string,
): AgentTranscriptEntry {
  if (entry.type === "accepted_input") {
    return {
      ...entry,
      messages: entry.messages.map((message) => ({
        ...message,
        content: message.content.map((block) => retargetContentBlock(block, sourceSessionDir, targetSessionDir)),
      })),
    };
  }
  if (entry.type === "assistant_message" || entry.type === "tool_result_message" || entry.type === "durable_message") {
    return {
      ...entry,
      message: {
        ...entry.message,
        content: entry.message.content.map((block) => retargetContentBlock(block, sourceSessionDir, targetSessionDir)),
      },
    };
  }
  if (
    entry.type === "control_boundary" &&
    entry.boundary.kind === "compact" &&
    entry.boundary.subtype === "compact_boundary"
  ) {
    const snapshot = readCompactSnapshot(entry);
    if (snapshot) {
      return {
        ...entry,
        boundary: {
          ...entry.boundary,
          snapshot: {
            version: 1,
            messages: snapshot.map((message) => ({
              ...message,
              content: message.content.map((block) => retargetContentBlock(block, sourceSessionDir, targetSessionDir)),
            })),
          },
        },
      };
    }
  }
  return entry;
}

function retargetEntriesForNodeFork(
  entries: readonly AgentTranscriptEntry[],
  sourceSafeId: string,
  targetSafeId: string,
  sourceSessionDir: string,
  targetSessionDir: string,
): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    const retargeted = retargetTranscriptEntryAuxiliaryPaths(entry, sourceSessionDir, targetSessionDir);
    if (retargeted.type !== "subagent_started") return retargeted;
    return {
      ...retargeted,
      transcriptRelativePath: retargetRelativeSessionPath(
        retargeted.transcriptRelativePath,
        sourceSafeId,
        targetSafeId,
      ),
    };
  });
}

async function retargetCopiedSubagentTranscripts(
  targetSubagentsDir: string,
  sourceSessionDir: string,
  targetSessionDir: string,
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(targetSubagentsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(targetSubagentsDir, entry.name);
    if (entry.isDirectory()) {
      await retargetCopiedSubagentTranscripts(path, sourceSessionDir, targetSessionDir);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const content = await readFile(path, "utf8");
    const rewritten = content
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const parsed = JSON.parse(line) as AgentTranscriptEntry;
          return JSON.stringify(retargetTranscriptEntryAuxiliaryPaths(parsed, sourceSessionDir, targetSessionDir));
        } catch {
          return line;
        }
      })
      .join("\n");
    await writeFile(path, rewritten, "utf8");
  }
}

async function copySessionAuxDirs(sourceSessionDir: string, targetSessionDir: string): Promise<void> {
  for (const subdir of ["tool-results", "file-history", "subagents"] as const) {
    const source = join(sourceSessionDir, subdir);
    const target = join(targetSessionDir, subdir);
    if (!(await pathExists(source))) continue;
    await cp(source, target, { recursive: true, force: true });
    if (subdir === "subagents") {
      await retargetCopiedSubagentTranscripts(target, sourceSessionDir, targetSessionDir);
    }
  }
}

/** Native JSONL fork transaction, including file-aware auxiliary artifacts. */
export const nodeProjectSessionForkPort: ProjectSessionForkPort = Object.freeze({
  async fork(input) {
    const chatDir = getPilotProjectChatDir(input.projectRoot, input.pilotHome);
    const sourceSafeId = sanitizeSessionIdForPath(input.sourceSessionId);
    const targetSafeId = sanitizeSessionIdForPath(input.targetSessionId);
    const sourceSessionDir = resolve(chatDir, sourceSafeId);
    const targetSessionDir = resolve(chatDir, targetSafeId);
    const targetTranscriptPath = resolve(chatDir, `${targetSafeId}.jsonl`);
    const temporaryPath = resolve(chatDir, `.${targetSafeId}.${randomUUID()}.fork.tmp`);

    if (await pathExists(targetTranscriptPath) || await pathExists(targetSessionDir)) {
      throw new Error(`Fork target session already exists: ${input.targetSessionId}`);
    }

    let createdTargetDir = false;
    try {
      await mkdir(chatDir, { recursive: true, mode: 0o700 });
      await mkdir(targetSessionDir, { recursive: false, mode: 0o700 });
      createdTargetDir = true;
      await copySessionAuxDirs(sourceSessionDir, targetSessionDir);
      const entries = retargetEntriesForNodeFork(
        input.entries,
        sourceSafeId,
        targetSafeId,
        sourceSessionDir,
        targetSessionDir,
      );
      const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, targetTranscriptPath);
      await chmod(chatDir, 0o700);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (createdTargetDir) await rm(targetSessionDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  },
});
