import type { AgentLoopSeedState } from "../../loop/AgentLoop.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckWriteSnapshotMap,
} from "../../../tool/index.js";

/**
 * Validates the host-neutral checkpoint projection used at the AgentLoop
 * module boundary. The returned maps are new instances, so a host payload
 * cannot mutate an active loop after startup.
 */
export function parseAgentLoopSeedStateProjection(value: unknown): AgentLoopSeedState | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value);
  if (!source) throw new Error("Invalid sidecar seedState: expected an object.");

  const seed: AgentLoopSeedState = {};
  if (source.allowedReadFiles !== undefined) {
    if (!Array.isArray(source.allowedReadFiles) || source.allowedReadFiles.some((path) => typeof path !== "string")) {
      throw new Error("Invalid sidecar seedState.allowedReadFiles.");
    }
    seed.allowedReadFiles = [...source.allowedReadFiles];
  }
  if (source.readFileState !== undefined) seed.readFileState = parseReadFileState(source.readFileState);
  if (source.writeSnapshots !== undefined) seed.writeSnapshots = parseWriteSnapshots(source.writeSnapshots);
  return seed;
}

function parseReadFileState(value: unknown): PilotDeckReadFileStateMap {
  const source = asRecord(value);
  if (!source) throw new Error("Invalid sidecar seedState.readFileState.");
  const result: PilotDeckReadFileStateMap = new Map();
  for (const [path, rawEntry] of Object.entries(source)) {
    const entry = asRecord(rawEntry);
    if (!entry || typeof entry.mtimeMs !== "number" || !isReadKind(entry.kind)) {
      throw new Error(`Invalid readFileState entry: ${path}.`);
    }
    result.set(path, {
      mtimeMs: entry.mtimeMs,
      kind: entry.kind,
      ...(typeof entry.offset === "number" ? { offset: entry.offset } : {}),
      ...(typeof entry.limit === "number" ? { limit: entry.limit } : {}),
      ...(typeof entry.pages === "string" ? { pages: entry.pages } : {}),
    });
  }
  return result;
}

function parseWriteSnapshots(value: unknown): PilotDeckWriteSnapshotMap {
  const source = asRecord(value);
  if (!source) throw new Error("Invalid sidecar seedState.writeSnapshots.");
  const result: PilotDeckWriteSnapshotMap = new Map();
  for (const [path, rawEntry] of Object.entries(source)) {
    const entry = asRecord(rawEntry);
    if (!entry || typeof entry.absolutePath !== "string" || typeof entry.mtimeMs !== "number" || typeof entry.contentHash !== "string") {
      throw new Error(`Invalid writeSnapshots entry: ${path}.`);
    }
    result.set(path, {
      absolutePath: entry.absolutePath,
      mtimeMs: entry.mtimeMs,
      contentHash: entry.contentHash,
      ...(typeof entry.offset === "number" ? { offset: entry.offset } : {}),
      ...(typeof entry.limit === "number" ? { limit: entry.limit } : {}),
    });
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isReadKind(value: unknown): value is "text" | "image" | "pdf" | "notebook" {
  return value === "text" || value === "image" || value === "pdf" || value === "notebook";
}
