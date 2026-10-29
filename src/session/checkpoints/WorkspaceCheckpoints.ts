import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import { buildStructuredPatch } from "../../tool/builtin/filesystem/structuredPatch.js";
import { resolveRealWritePath } from "../../tool/builtin/filesystem/pathSafety.js";
import { acquireWorkspaceOperation, canonicalWorkspacePath, hasWorkspaceTurn, operationContext, registerWorkspaceTurn, workspaceOperationState } from "./WorkspaceCoordinator.js";

import type { FileVersion, FileChange, Checkpoint, CheckpointSummary, RestorePlan, RestoreOperation, CheckpointRequest } from "./types.js";
export type { FileVersion, FileChange, Checkpoint, CheckpointSummary, RestorePlan, RestoreOperation, CheckpointRequest } from "./types.js";

const EXCLUDED = new Set([".git", ".pilotdeck", ".tmp", "node_modules", ".venv", "venv", "dist", "build", "coverage", ".next", ".cache", "__pycache__"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
const ABSENT: FileVersion = { kind: "absent" };
const stores = new Map<string, Promise<CheckpointStore>>();
const storageActivity = new Map<string, { pins: number; gc?: Promise<void> }>();
type TrackedEdit = { before: FileVersion; after?: FileVersion; source?: FileChange["source"]; uncertain?: boolean; beforeRevision?: string; afterRevision?: string; workspaceRevision?: string; segments?: FileChange[] };
type EditRecord = TrackedEdit & { id: string; beforeId: string; path: string; sessionId?: string; turnId?: string; parentOperationId?: string; createdAt?: string };

function mergeTrackedEdit(tracked: Map<string, TrackedEdit>, relative: string, edit: TrackedEdit): void {
  const previous = tracked.get(relative);
  const interrupted = previous && (!sameOnDisk(previous.after ?? ABSENT, edit.before)
    || (previous.afterRevision !== undefined && previous.afterRevision !== edit.beforeRevision) || previous.workspaceRevision !== edit.workspaceRevision);
  if (!previous) { tracked.set(relative, edit); return; }
  if (previous?.uncertain || edit.uncertain || interrupted) {
    const segment = (value: TrackedEdit): FileChange => ({ path: relative, before: value.before, after: value.after ?? ABSENT,
      source: value.source ?? "file_tool", added: 0, removed: 0, beforeRevision: value.beforeRevision, afterRevision: value.afterRevision });
    tracked.set(relative, { ...edit, uncertain: true, segments: [...(previous?.segments ?? (previous ? [segment(previous)] : [])), ...(edit.segments ?? [segment(edit)])] });
  } else tracked.set(relative, { ...edit, before: previous?.before ?? edit.before, beforeRevision: previous?.beforeRevision ?? edit.beforeRevision,
    source: previous?.source === "file_tool" || edit.source === "file_tool" ? "file_tool" : edit.source });
}

export class CheckpointError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export async function getCheckpointStore(workspace: string, pilotHome: string): Promise<CheckpointStore> {
  const root = canonicalPath(await fs.realpath(workspace));
  const key = `${path.resolve(pilotHome)}\0${root}`;
  let pending = stores.get(key);
  if (!pending) {
    const workspaceId = digest(Buffer.from(root)).slice(0, 24);
    pending = (async () => {
      // Keep backup storage outside project registration directories, including aliased roots.
      const directory = path.join(path.resolve(pilotHome), "checkpoints", workspaceId);
      const legacy = path.resolve(getPilotProjectChatDir(root, pilotHome), "..", "checkpoints", workspaceId);
      await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      if ((await fs.stat(legacy).catch(() => undefined))?.isDirectory() && !await fs.stat(directory).catch(() => undefined)) {
        await fs.rename(legacy, directory).catch(async error => { if (!(await fs.stat(directory).catch(() => undefined))?.isDirectory()) throw error; });
      }
      return new CheckpointStore(root, directory);
    })();
    stores.set(key, pending);
    void pending.catch(() => { if (stores.get(key) === pending) stores.delete(key); });
  }
  return pending;
}

/** Immutable objects and manifests. Directory leases protect mutations, never agent turns. */
export class CheckpointStore {
  constructor(public readonly workspace: string, public readonly directory: string) { this.workspace = canonicalPath(workspace); }

  get busy(): boolean { return workspaceOperationState(this.workspace).busy; }
  get busyReason(): string | undefined { return workspaceOperationState(this.workspace).reason; }
  async pin(): Promise<() => void> {
    let state = storageActivity.get(this.directory);
    if (!state) { state = { pins: 0 }; storageActivity.set(this.directory, state); }
    state.pins++;
    await state.gc?.catch(() => {});
    let released = false;
    return () => { if (!released) { released = true; state!.pins--; } };
  }
  acquire(signal?: AbortSignal): Promise<() => void> { return acquireWorkspaceOperation(this.workspace, { signal }); }
  async withExclusive<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = operationContext.getStore()?.owner ?? {};
    const release = await acquireWorkspaceOperation(this.workspace, { owner, signal });
    const unpin = await this.pin();
    try { return await operationContext.run({ owner }, task); } finally { unpin(); release(); }
  }
  private headPath(relative: string): string {
    return path.join(path.dirname(this.directory), "file-heads", `${digest(Buffer.from(canonicalPath(path.join(this.workspace, relative))))}.json`);
  }
  async revision(relative: string): Promise<string> {
    try { return (JSON.parse(await fs.readFile(this.headPath(relative), "utf8")) as { revision: string }).revision; }
    catch (error) { if (hasCode(error, "ENOENT")) return ""; throw error; }
  }
  async advance(relative: string, revision: string = randomUUID()): Promise<string> {
    const destination = this.headPath(relative);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await this.atomicWrite(destination, Buffer.from(JSON.stringify({ revision })), true);
    return revision;
  }
  async scopeRevision(): Promise<string> {
    const revisions: string[] = [];
    for (let scope = this.workspace;; scope = path.dirname(scope)) {
      const file = path.join(path.dirname(this.directory), "file-heads", `scope-${digest(Buffer.from(scope))}.json`);
      try { revisions.push(await fs.readFile(file, "utf8")); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      if (path.dirname(scope) === scope) break;
    }
    return revisions.join(":");
  }
  async invalidateWorkspace(): Promise<void> {
    const file = path.join(path.dirname(this.directory), "file-heads", `scope-${digest(Buffer.from(this.workspace))}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await this.atomicWrite(file, Buffer.from(randomUUID()), true);
  }
  private recordPath(kind: "manifests" | "plans" | "operations" | "edits", id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new CheckpointError("INVALID_ID", "Invalid checkpoint identifier.");
    return path.join(this.directory, kind, `${id}.json`);
  }
  private objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new CheckpointError("INVALID_OBJECT", "Invalid content object.");
    return path.join(this.directory, "objects", hash);
  }
  async putObject(content: Buffer): Promise<string> {
    const hash = digest(content), destination = this.objectPath(hash);
    try { await this.readObject(hash); return hash; }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try { await this.atomicWrite(destination, content, false); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    return hash;
  }
  async readObject(hash: string): Promise<Buffer> {
    const content = await fs.readFile(this.objectPath(hash));
    if (digest(content) !== hash) throw new CheckpointError("CORRUPT_BACKUP", "Checkpoint content is missing or corrupt.");
    return content;
  }
  private async writeRecord(kind: "manifests" | "plans" | "operations" | "edits", value: { id: string }, update = false): Promise<void> {
    const destination = this.recordPath(kind, value.id);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await this.atomicWrite(destination, Buffer.from(JSON.stringify(value)), update);
  }
  private async atomicWrite(destination: string, content: Buffer, update: boolean): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      if (update) await fs.rename(temporary, destination); else await fs.link(temporary, destination);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async readCheckpoint(id: string, sessionId: string): Promise<Checkpoint> {
    const checkpoint = JSON.parse(await fs.readFile(this.recordPath("manifests", id), "utf8")) as Checkpoint;
    if (checkpoint.version !== 1 || checkpoint.workspace !== this.workspace || checkpoint.sessionId !== sessionId) {
      throw new CheckpointError("CHECKPOINT_MISMATCH", "Checkpoint does not belong to this conversation and directory.");
    }
    return this.normalizeCheckpoint(checkpoint);
  }
  /** Resolve spelling through the filesystem, without following a file symlink. */
  async normalizeFilePath(relative: string): Promise<string> {
    const target = await this.resolveFile(relative);
    const info = await fs.lstat(target).catch(error => { if (hasCode(error, "ENOENT")) return undefined; throw error; });
    const actual = info?.isSymbolicLink() ? target : canonicalPath(target);
    const normalized = path.relative(this.workspace, actual).split(path.sep).join("/");
    await this.resolveFile(normalized);
    return normalized;
  }
  private async fileAliases(paths: string[]): Promise<Map<string, string>> {
    const groups = new Map<string, string[]>();
    for (const relative of new Set(paths)) {
      const key = relative.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), relative]);
    }
    const aliases = new Map<string, string>();
    // Only ambiguous spellings require extra filesystem lookups. On a case-
    // sensitive volume realpath keeps the two files distinct.
    for (const group of groups.values()) if (group.length > 1) {
      for (const relative of group) aliases.set(relative, await this.normalizeFilePath(relative).catch(() => relative));
    }
    return aliases;
  }
  private async normalizeCheckpoint(checkpoint: Checkpoint, aliases?: Map<string, string>): Promise<Checkpoint> {
    const changes = checkpoint.changes;
    if (!changes?.length) return checkpoint;
    aliases ??= await this.fileAliases(changes.map(change => change.path));
    const normalized = new Map<string, FileChange>();
    for (const change of changes) {
      const relative = aliases.get(change.path) ?? change.path, previous = normalized.get(relative);
      if (!previous || (previous.source !== "file_tool" && change.source === "file_tool")) normalized.set(relative, { ...change, path: relative });
      else if (previous.source === change.source && (!same(previous.before, change.before) || !same(previous.after, change.after))) {
        // Ambiguous old records remain reviewable, but cannot overwrite files.
        normalized.set(relative, { ...previous, uncertain: true });
      }
    }
    return { ...checkpoint, changes: [...normalized.values()] };
  }
  async resolveFile(relative: string): Promise<string> {
    if (!relative || relative.includes("\0") || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new CheckpointError("INVALID_PATH", "Invalid checkpoint file path.");
    }
    const target = path.resolve(this.workspace, relative);
    if (!inside(this.workspace, target) || relative.split(/[\\/]/).includes(".git")) throw new CheckpointError("INVALID_PATH", "Path is outside the protected directory.");
    let parent = path.dirname(target);
    while (parent !== this.workspace) {
      try {
        const info = await fs.lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new CheckpointError("UNSAFE_PATH", "A parent directory was replaced or is a symbolic link.");
      } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      parent = path.dirname(parent);
    }
    const actualRoot = await fs.realpath(this.workspace);
    if (actualRoot !== this.workspace) throw new CheckpointError("UNSAFE_PATH", "The workspace directory has moved.");
    return target;
  }
  async captureFile(relative: string, save = true): Promise<FileVersion> {
    const target = await this.resolveFile(relative);
    for (let attempt = 0; attempt < 3; attempt++) {
      let before;
      try { before = await fs.lstat(target); }
      catch (error) { if (hasCode(error, "ENOENT")) return ABSENT; throw error; }
      const unprotected = async (reason: string): Promise<FileVersion> => ({ kind: "unprotected", reason,
        fingerprint: digest(Buffer.from(JSON.stringify([before.dev, before.ino, before.mode, before.size, before.mtimeMs, before.ctimeMs,
          before.isSymbolicLink() ? await fs.readlink(target) : null]))) });
      if (!before.isFile() || before.isSymbolicLink()) return unprotected("Symbolic links and non-regular files are not restored automatically.");
      if (before.size > MAX_FILE_BYTES) return unprotected("File exceeds the 10 MB checkpoint limit.");
      let content: Buffer;
      try {
        const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== before.ino) continue;
          content = await handle.readFile();
        } finally { await handle.close(); }
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        if (hasCode(error, "ELOOP")) return { kind: "unprotected", reason: "File was replaced with a symbolic link." };
        throw error;
      }
      let after;
      try { after = await fs.lstat(target); } catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue;
      const hash = save ? await this.putObject(content) : digest(content);
      return { kind: "file", hash, size: content.length, mode: before.mode & 0o777, binary: content.includes(0),
        fingerprint: digest(Buffer.from(JSON.stringify([before.dev, before.ino, before.size, before.mode, before.mtimeMs, before.ctimeMs]))) };
    }
    return { kind: "unprotected", reason: "File changed while its checkpoint was being captured." };
  }
  async capture(sessionId: string, turnId: string, phase: Checkpoint["phase"], context?: CanonicalMessage[]): Promise<Checkpoint> {
    const files: Record<string, FileVersion> = {};
    let bytes = 0;
    const walk = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(directory, entry.name), relative = path.relative(this.workspace, target).split(path.sep).join("/");
        if (entry.name === ".git") continue; // Worktrees use a .git file instead of a directory.
        if (entry.isDirectory()) {
          if (!EXCLUDED.has(entry.name)) {
            try { await this.resolveFile(`${relative}/.checkpoint-boundary`); await walk(target); }
            catch { files[relative] = { kind: "unprotected", reason: "Directory changed or could not be read during capture." }; }
          }
          continue;
        }
        if (entry.name.startsWith(".pilotdeck-restore-")) continue;
        if (bytes >= MAX_WORKSPACE_BYTES) {
          const info = await fs.lstat(target);
          files[relative] = { kind: "unprotected", reason: "Workspace exceeds the 256 MB checkpoint budget.", fingerprint: digest(Buffer.from(JSON.stringify([info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]))) }; continue;
        }
        try { files[relative] = await this.captureFile(relative); }
        catch (error) { files[relative] = { kind: "unprotected", reason: error instanceof Error ? error.message : "Cannot capture file." }; }
        if (files[relative].kind === "file") bytes += (files[relative] as Extract<FileVersion, { kind: "file" }>).size;
      }
    };
    await walk(this.workspace);
    return { version: 1, id: randomUUID(), sessionId, turnId, workspace: this.workspace, createdAt: new Date().toISOString(), phase, status: "complete", files,
      ...(context ? { contextHash: await this.putObject(Buffer.from(JSON.stringify(context))) } : {}) };
  }
  async save(checkpoint: Checkpoint, update = false): Promise<void> { await this.writeRecord("manifests", checkpoint, update); }
  async list(sessionId: string): Promise<Checkpoint[]> {
    const directory = path.join(this.directory, "manifests");
    const names = await fs.readdir(directory).catch(error => { if (hasCode(error, "ENOENT")) return []; throw error; });
    const records: Checkpoint[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const checkpoint = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Checkpoint;
      if (checkpoint.version === 1 && checkpoint.sessionId === sessionId && checkpoint.workspace === this.workspace) records.push(checkpoint);
    }
    const aliases = await this.fileAliases(records.flatMap(record => (record.changes ?? []).map(change => change.path)));
    const superseded = new Set(records.flatMap(record => record.supersedesId ? [record.supersedesId] : []));
    return (await Promise.all(records.filter(record => !superseded.has(record.id)).map(record => this.normalizeCheckpoint(record, aliases)))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  summary(checkpoint: Checkpoint): CheckpointSummary {
    const { files, contextHash: _context, changes, ...rest } = checkpoint;
    return { ...rest, unprotected: new Set([...Object.keys(files).filter(relative => files[relative].kind === "unprotected"), ...(changes ?? []).filter(change => change.uncertain || change.before.kind === "unprotected" || change.after.kind === "unprotected").map(change => change.path)]).size,
      changes: (changes ?? []).map(({ before, after, segments: _segments, ...change }) => ({ ...change,
        operation: before.kind === "absent" ? "created" : after.kind === "absent" ? "deleted" : "updated",
        restorable: !change.uncertain && before.kind !== "unprotected" && after.kind !== "unprotected",
        binary: (before.kind === "file" && before.binary) || (after.kind === "file" && after.binary) })) };
  }
  async changes(before: Checkpoint, after: Checkpoint, tracked = new Map<string, TrackedEdit>()): Promise<FileChange[]> {
    const aliases = await this.fileAliases([...Object.keys(before.files), ...Object.keys(after.files), ...tracked.keys()]);
    const normalizeFiles = (files: Record<string, FileVersion>) => Object.fromEntries(Object.entries(files).map(([relative, version]) => [aliases.get(relative) ?? relative, version]));
    before = { ...before, files: normalizeFiles(before.files) };
    after = { ...after, files: normalizeFiles(after.files) };
    tracked = new Map([...tracked].map(([relative, edit]) => [aliases.get(relative) ?? relative, edit]));
    const changes: FileChange[] = [];
    for (const relative of new Set(before.journalVersion === 2 ? tracked.keys() : [...Object.keys(before.files), ...Object.keys(after.files), ...tracked.keys()])) {
      const tool = tracked.get(relative);
      // A tool preimage can be an intermediate version after an earlier command.
      // Missing entries in a scanned directory mean absent at the turn boundary;
      // excluded work directories instead depend on their explicit edit journal.
      const left = before.journalVersion === 2 ? tool?.before ?? ABSENT : before.files[relative] ?? (scannedPath(relative) ? ABSENT : tool?.before ?? ABSENT);
      const right = tool?.after ?? after.files[relative] ?? ABSENT;
      if (same(left, right) && (!tool?.uncertain || (tool.source === "observed" && !tool.segments?.length))) continue;
      let added = 0, removed = 0;
      if (left.kind !== "unprotected" && right.kind !== "unprotected" && !(left.kind === "file" && left.binary) && !(right.kind === "file" && right.binary)) {
        const oldText = left.kind === "file" ? (await this.readObject(left.hash)).toString("utf8") : null;
        const newText = right.kind === "file" ? (await this.readObject(right.hash)).toString("utf8") : "";
        if ((oldText?.length ?? 0) + newText.length <= 500_000) {
          for (const hunk of buildStructuredPatch(oldText, newText)) for (const line of hunk.lines) {
            if (line.type === "add") added++; else if (line.type === "delete") removed++;
          }
        }
      }
      if (tool?.segments?.length) {
        added = 0; removed = 0;
        for (const segment of tool.segments) {
          const stats = await this.changes({ ...before, journalVersion: undefined, files: { [relative]: segment.before } }, { ...after, journalVersion: undefined, files: { [relative]: segment.after } });
          added += stats[0]?.added ?? 0; removed += stats[0]?.removed ?? 0;
        }
      }
      changes.push({ path: relative, before: left, after: right, source: tool?.after ? tool.source ?? "file_tool" : "observed", added, removed,
        ...(tool?.uncertain ? { uncertain: true } : {}), ...(tool?.beforeRevision !== undefined ? { beforeRevision: tool.beforeRevision } : {}),
        ...(tool?.afterRevision !== undefined ? { afterRevision: tool.afterRevision } : {}), ...(tool?.segments ? { segments: tool.segments } : {}) });
      if (tool?.workspaceRevision !== undefined) changes[changes.length - 1].workspaceRevision = tool.workspaceRevision;
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  async selectChanges(checkpoint: Checkpoint, scope: CheckpointRequest["scope"], _activeTurns?: Set<string>): Promise<FileChange[]> {
    if (!scope || scope === "turn") return checkpoint.changes ?? [];
    // Conversation visibility does not reverse file edits. Replay the actual
    // filesystem timeline, including hidden turns and their restore/undo events.
    const records = (await this.list(checkpoint.sessionId)).filter(item => item.phase === "after" && (scope === "session" || item.createdAt >= checkpoint.createdAt));
    const first = records[0];
    const firstBefore = first?.beforeId ? await this.readCheckpoint(first.beforeId, checkpoint.sessionId) : first;
    const cutoff = scope === "session" ? firstBefore?.createdAt ?? checkpoint.createdAt : checkpoint.createdAt;
    const events = records.map(record => ({ createdAt: record.createdAt, changes: record.changes ?? [] }));
    for (const operation of await this.operations(checkpoint.sessionId)) {
      if (operation.createdAt < cutoff) continue;
      const applied = operation.files.filter(file => operation.applied.includes(file.path));
      events.push({ createdAt: operation.createdAt, changes: applied.map(file => ({ path: file.path, before: file.expected, after: file.result ?? file.target, source: file.source, added: 0, removed: 0, beforeRevision: file.expectedRevision, afterRevision: file.resultRevision, workspaceRevision: operation.workspaceRevision })) });
    }
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const aliases = await this.fileAliases(events.flatMap(event => event.changes.map(change => change.path)));
    const cumulative = new Map<string, FileChange>();
    for (const record of events) for (const raw of record.changes) {
      const change = { ...raw, path: aliases.get(raw.path) ?? raw.path };
      const earlier = cumulative.get(change.path);
      if (earlier && (!same(earlier.after, change.before) || (earlier.afterRevision !== undefined && change.beforeRevision !== undefined && earlier.afterRevision !== change.beforeRevision)
        || (earlier.workspaceRevision !== undefined && change.workspaceRevision !== undefined && earlier.workspaceRevision !== change.workspaceRevision))) {
        cumulative.set(change.path, { ...change, uncertain: true, segments: [...(earlier.segments ?? [earlier]), ...(change.segments ?? [change])] });
      } else cumulative.set(change.path, { ...change, before: earlier?.before ?? change.before, beforeRevision: earlier?.beforeRevision ?? change.beforeRevision,
        ...((earlier?.uncertain || change.uncertain) ? { uncertain: true, segments: [...(earlier?.segments ?? (earlier ? [earlier] : [])), ...(change.segments ?? [change])] } : {}) });
    }
    const combined = [...cumulative.values()].filter(change => change.uncertain || !same(change.before, change.after));
    const left = { ...checkpoint, journalVersion: undefined, files: Object.fromEntries(combined.map(change => [change.path, change.before])) };
    const right = { ...checkpoint, journalVersion: undefined, files: Object.fromEntries(combined.map(change => [change.path, change.after])) };
    const stats = await this.changes(left, right);
    return combined.map(change => ({ ...change, added: stats.find(item => item.path === change.path)?.added ?? 0, removed: stats.find(item => item.path === change.path)?.removed ?? 0 }));
  }
  async diff(sessionId: string, checkpointId: string, relative: string, scope?: CheckpointRequest["scope"], activeTurns?: Set<string>) {
    const checkpoint = await this.readCheckpoint(checkpointId, sessionId);
    const changes = await this.selectChanges(checkpoint, scope, activeTurns);
    const aliases = await this.fileAliases([...changes.map(change => change.path), relative]);
    const change = changes.find(item => (aliases.get(item.path) ?? item.path) === (aliases.get(relative) ?? relative));
    if (!change) throw new CheckpointError("FILE_NOT_RECORDED", "File is not part of this checkpoint.");
    const text = async (version: FileVersion) => version.kind === "file" && !version.binary && version.size <= 500_000 ? (await this.readObject(version.hash)).toString("utf8") : null;
    const oldContent = change.before.kind === "absent" ? "" : await text(change.before), newContent = change.after.kind === "absent" ? "" : await text(change.after);
    const segments = change.segments ? await Promise.all(change.segments.map(async item => ({ ...item,
      oldContent: item.before.kind === "absent" ? "" : await text(item.before), newContent: item.after.kind === "absent" ? "" : await text(item.after),
      hunks: (item.before.kind === "absent" || await text(item.before) !== null) && (item.after.kind === "absent" || await text(item.after) !== null)
        ? buildStructuredPatch(item.before.kind === "absent" ? null : await text(item.before), item.after.kind === "absent" ? "" : (await text(item.after))!) : null }))) : undefined;
    return { ...change, segments, oldContent, newContent, hunks: oldContent !== null && newContent !== null ? buildStructuredPatch(change.before.kind === "absent" ? null : oldContent, newContent) : null };
  }
  async preview(sessionId: string, checkpointId: string, scope: CheckpointRequest["scope"] = "turn", mode: RestorePlan["mode"] = "files", context: Pick<RestorePlan, "contextBeforeHash" | "visibleSequences" | "visibleBeforeSequences"> = {}, activeTurns?: Set<string>): Promise<RestorePlan> {
    if (!["turn", "session", "since"].includes(scope) || !["files", "both", "conversation"].includes(mode)) throw new CheckpointError("INVALID_ACTION", "Invalid restore options.");
    const checkpoint = await this.readCheckpoint(checkpointId, sessionId);
    const before = checkpoint.beforeId ? await this.readCheckpoint(checkpoint.beforeId, sessionId) : checkpoint;
    const first = scope === "session" ? (await this.list(sessionId)).find(item => item.phase === "before" && (!activeTurns || activeTurns.has(item.turnId))) : before;
    const plan: RestorePlan = { id: randomUUID(), sessionId, checkpointId, createdAt: new Date().toISOString(), mode, scope, files: [], contextHash: first?.contextHash, workspaceRevision: await this.scopeRevision(), ...context };
    for (const change of await this.selectChanges(checkpoint, scope, activeTurns)) {
      const current = await this.captureFile(change.path, false);
      const revision = await this.revision(change.path);
      plan.files.push({ path: change.path, expected: current, target: change.before, source: change.source,
        expectedRevision: revision,
        status: change.uncertain || change.before.kind === "unprotected" || change.after.kind === "unprotected" || current.kind === "unprotected" ? "unprotected" : same(current, change.before) ? "unchanged"
          : sameOnDisk(current, change.after) && (change.afterRevision === undefined || change.afterRevision === revision)
            && (change.workspaceRevision === undefined || change.workspaceRevision === plan.workspaceRevision) ? "ready" : "conflict" });
    }
    await this.writeRecord("plans", plan);
    return plan;
  }
  async restore(sessionId: string, planId: string, selectedPaths?: string[]): Promise<RestoreOperation> {
    if ((await this.readPlan(sessionId, planId)).mode !== "conversation") return this.withExclusive(() => this.restoreUnlocked(sessionId, planId, selectedPaths));
    const unpin = await this.pin();
    try { return await this.restoreUnlocked(sessionId, planId, selectedPaths); } finally { unpin(); }
  }
  private async restoreUnlocked(sessionId: string, planId: string, selectedPaths?: string[]): Promise<RestoreOperation> {
    const plan = await this.readPlan(sessionId, planId);
    if (plan.sessionId !== sessionId) throw new CheckpointError("CHECKPOINT_MISMATCH", "Restore belongs to another conversation.");
    const operationPath = this.recordPath("operations", plan.id);
    try {
      const existing = JSON.parse(await fs.readFile(operationPath, "utf8")) as RestoreOperation;
      if (existing.status !== "complete") throw new CheckpointError("RESTORE_INTERRUPTED", `Restore ${existing.id} was interrupted. Undo this operation before retrying.`);
      return existing;
    }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    if (Date.now() - Date.parse(plan.createdAt) > 15 * 60_000) throw new CheckpointError("STALE_PLAN", "Restore preview expired. Review the current files again.");
    if (plan.mode !== "conversation" && plan.workspaceRevision !== undefined && plan.workspaceRevision !== await this.scopeRevision()) throw new CheckpointError("STALE_PLAN", "The project branch changed after the preview. Review it again.");
    const selected = selectedPaths ? new Set(await Promise.all(selectedPaths.map(relative => this.normalizeFilePath(relative)))) : undefined;
    const chosen = plan.mode === "conversation" ? [] : plan.files.filter(file => file.status === "ready" && (!selected || selected.has(file.path)));
    for (const file of chosen) {
      if (!sameOnDisk(await this.captureFile(file.path, false), file.expected) || (file.expectedRevision !== undefined && file.expectedRevision !== await this.revision(file.path))) throw new CheckpointError("STALE_PLAN", `${file.path} changed after the preview. Review it again.`);
      if (file.target.kind === "file") await this.readObject(file.target.hash);
    }
    if (plan.mode !== "files" && !plan.contextHash) throw new CheckpointError("CONTEXT_UNAVAILABLE", "This checkpoint has no saved conversation context.");
    const before: Checkpoint = plan.mode === "conversation"
      ? { version: 1, id: randomUUID(), sessionId, turnId: "restore", workspace: this.workspace, createdAt: new Date().toISOString(), phase: "before_restore", status: "complete", files: {} }
      : await this.capture(sessionId, "restore", "before_restore");
    before.contextHash = plan.contextBeforeHash;
    await this.save(before);
    const operation: RestoreOperation = { ...plan, createdAt: new Date().toISOString(), beforeId: before.id, status: "prepared", applied: [], skipped: plan.files.filter(file => !chosen.includes(file)).map(file => file.path) };
    await this.writeRecord("operations", operation);
    if (plan.mode === "conversation") { operation.status = "complete"; await this.writeRecord("operations", operation, true); return operation; }
    operation.status = "applying";
    await this.writeRecord("operations", operation, true);
    try {
      for (const file of chosen) {
        if (!sameOnDisk(await this.captureFile(file.path, false), file.expected) || (file.expectedRevision !== undefined && file.expectedRevision !== await this.revision(file.path))) throw new CheckpointError("STALE_PLAN", `${file.path} changed during restore.`);
        operation.pendingPath = file.path;
        await this.writeRecord("operations", operation, true);
        await this.applyFile(file.path, file.target);
        file.result = await this.captureFile(file.path);
        file.resultRevision = await this.advance(file.path);
        operation.applied.push(file.path);
        delete operation.pendingPath;
        await this.writeRecord("operations", operation, true);
      }
      operation.status = "complete";
    } catch (error) {
      operation.status = "needs_recovery";
      await this.writeRecord("operations", operation, true);
      throw new CheckpointError("RESTORE_INTERRUPTED", `Restore interrupted; undo operation ${operation.id} to recover. ${error instanceof Error ? error.message : ""}`);
    }
    await this.writeRecord("operations", operation, true);
    return operation;
  }
  async readPlan(sessionId: string, id: string): Promise<RestorePlan> {
    const plan = JSON.parse(await fs.readFile(this.recordPath("plans", id), "utf8")) as RestorePlan;
    if (plan.sessionId !== sessionId) throw new CheckpointError("CHECKPOINT_MISMATCH", "Restore belongs to another conversation.");
    const files = new Map<string, RestorePlan["files"][number]>();
    for (const file of plan.files) {
      const relative = await this.normalizeFilePath(file.path), previous = files.get(relative);
      if (previous && (!same(previous.expected, file.expected) || !same(previous.target, file.target) || previous.status !== file.status)) {
        throw new CheckpointError("STALE_PLAN", "Restore preview contains conflicting records for the same file. Review the current files again.");
      }
      files.set(relative, { ...file, path: relative });
    }
    return { ...plan, files: [...files.values()] };
  }
  private async applyFile(relative: string, version: FileVersion): Promise<void> {
    if (version.kind === "unprotected") throw new CheckpointError("UNPROTECTED", "Cannot restore an unprotected file.");
    const target = await this.resolveFile(relative);
    if (version.kind === "absent") { await fs.unlink(target).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); return; }
    const content = await this.readObject(version.hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.pilotdeck-restore-${randomUUID()}`);
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: version.mode });
      await fs.chmod(temporary, version.mode);
      await this.resolveFile(relative);
      const current = await fs.lstat(target).catch(error => { if (hasCode(error, "ENOENT")) return undefined; throw error; });
      if (current?.isSymbolicLink() || (current && !current.isFile())) throw new CheckpointError("UNSAFE_PATH", "Restore target is no longer a regular file.");
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async undoPreview(sessionId: string, operationId: string, context: Pick<RestorePlan, "contextBeforeHash" | "visibleBeforeSequences"> & { mode?: RestorePlan["mode"] } = {}): Promise<RestorePlan> {
    const operation = JSON.parse(await fs.readFile(this.recordPath("operations", operationId), "utf8")) as RestoreOperation;
    if (operation.sessionId !== sessionId) throw new CheckpointError("CHECKPOINT_MISMATCH", "Restore belongs to another conversation.");
    const before = await this.readCheckpoint(operation.beforeId, sessionId);
    const plan: RestorePlan = { id: randomUUID(), checkpointId: before.id, sessionId, createdAt: new Date().toISOString(), mode: operation.mode, files: [], contextHash: operation.contextBeforeHash, visibleSequences: operation.visibleBeforeSequences, undoOf: operation.id, workspaceRevision: await this.scopeRevision(), ...context };
    const affected = new Set(operation.applied);
    if (operation.pendingPath) {
      const pending = operation.files.find(file => file.path === operation.pendingPath);
      if (pending && !same(await this.captureFile(pending.path, false), pending.expected)) affected.add(pending.path);
    }
    for (const relative of affected) {
      const original = operation.files.find(file => file.path === relative)!;
      const current = await this.captureFile(relative, false);
      const revision = await this.revision(relative);
      plan.files.push({ path: relative, expected: current, target: original.expected, source: original.source,
        expectedRevision: revision,
        status: same(current, original.expected) ? "unchanged" : sameOnDisk(current, original.result ?? original.target) && (original.resultRevision === undefined || original.resultRevision === revision)
          && (operation.workspaceRevision === undefined || operation.workspaceRevision === plan.workspaceRevision) ? "ready" : "conflict" });
    }
    await this.writeRecord("plans", plan);
    return plan;
  }
  async operations(sessionId: string): Promise<RestoreOperation[]> {
    const directory = path.join(this.directory, "operations"), names = await fs.readdir(directory).catch(error => { if (hasCode(error, "ENOENT")) return []; throw error; });
    const records: RestoreOperation[] = [];
    for (const name of names.filter(name => name.endsWith(".json"))) {
      const record = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as RestoreOperation;
      if (record.sessionId === sessionId) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async saveEdit(edit: EditRecord, update = false): Promise<void> {
    await this.writeRecord("edits", edit, update);
  }
  /** Caller owns the lease. Unknown post-crash edits remain reviewable but cannot be overwritten. */
  async recoverInterrupted(sessionId: string): Promise<void> {
    const records = await this.list(sessionId), completed = new Set(records.filter(record => record.phase === "after").map(record => record.beforeId));
    const orphan = records.filter(record => record.phase === "before").at(-1);
    if (!orphan || completed.has(orphan.id)) return;
    if (hasWorkspaceTurn(this.workspace, sessionId, orphan.turnId)) return;
    const names = await fs.readdir(path.join(this.directory, "edits")).catch(error => { if (hasCode(error, "ENOENT")) return []; throw error; });
    const tracked = new Map<string, TrackedEdit>();
    const edits = await Promise.all(names.filter(value => value.endsWith(".json")).map(async name => JSON.parse(await fs.readFile(path.join(this.directory, "edits", name), "utf8")) as EditRecord));
    const completedCommands = new Set(records.filter(record => record.phase === "command" && record.status === "complete").map(record => record.id));
    for (const edit of edits.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))) {
      if (edit.beforeId === orphan.id && !(edit.parentOperationId && completedCommands.has(edit.parentOperationId))) {
        if (!edit.after) { edit.after = await this.captureFile(edit.path); edit.uncertain = true; }
        mergeTrackedEdit(tracked, edit.path, edit);
      }
    }
    const after = await this.capture(sessionId, orphan.turnId, "after");
    after.beforeId = orphan.id; after.status = "incomplete";
    after.journalVersion = orphan.journalVersion;
    for (const command of records.filter(record => record.phase === "command" && record.beforeId === orphan.id && record.status === "incomplete")) {
      for (const change of await this.changes(command, after)) tracked.set(change.path, { ...change, uncertain: true });
    }
    after.changes = (await this.changes(orphan, after, tracked)).map(change => ({ ...change, ...(!tracked.get(change.path)?.after ? { uncertain: true } : {}) }));
    await this.save(after);
  }
  /** Keep 100 rounds and completed restores per conversation, then collect unused blobs. Caller owns the lease. */
  async prune(retain = 100): Promise<void> {
    // Objects may have been written but not published in their manifest yet.
    if (hasWorkspaceTurn(this.workspace) || this.busy) return;
    let state = storageActivity.get(this.directory);
    if (!state) { state = { pins: 0 }; storageActivity.set(this.directory, state); }
    if (state.pins || state.gc) return;
    const gc = this.pruneUnpinned(retain);
    state.gc = gc;
    try { await gc; } finally { if (state.gc === gc) state.gc = undefined; }
  }
  private async pruneUnpinned(retain: number): Promise<void> {
    const readRecords = async (kind: "manifests" | "plans" | "operations" | "edits") => {
      const names = await fs.readdir(path.join(this.directory, kind)).catch(error => { if (hasCode(error, "ENOENT")) return []; throw error; });
      return Promise.all(names.filter(name => name.endsWith(".json")).map(async name => ({ name, record: JSON.parse(await fs.readFile(path.join(this.directory, kind, name), "utf8")) as Checkpoint & RestoreOperation })));
    };
    const [manifests, plans, operations, edits] = await Promise.all([readRecords("manifests"), readRecords("plans"), readRecords("operations"), readRecords("edits")]);
    const keep = new Set<string>(), retainedOperations = new Set<string>();
    const sessions = new Set(manifests.map(item => item.record.sessionId));
    for (const sessionId of sessions) {
      const superseded = new Set(manifests.flatMap(item => item.record.supersedesId ? [item.record.supersedesId] : []));
      const rounds = manifests.filter(item => item.record.sessionId === sessionId && item.record.phase === "after" && !superseded.has(item.record.id)).sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)).slice(0, retain);
      for (const { record } of rounds) { keep.add(record.id); if (record.beforeId) keep.add(record.beforeId); }
      const restored = operations.filter(item => item.record.sessionId === sessionId).sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
      for (const { record } of restored.filter((item, index) => item.record.status !== "complete" || index < retain)) {
        retainedOperations.add(record.id); keep.add(record.beforeId); keep.add(record.checkpointId);
      }
      const completedBefore = new Set(manifests.filter(item => item.record.phase === "after").map(item => item.record.beforeId));
      for (const { record } of manifests.filter(item => item.record.sessionId === sessionId && item.record.phase === "before" && !completedBefore.has(item.record.id)).slice(-retain)) keep.add(record.id);
    }
    const retainedPlans = plans.filter(item => Date.now() - Date.parse(item.record.createdAt) <= 15 * 60_000);
    for (const { record } of retainedPlans) keep.add(record.checkpointId);
    // Preserve supersession links, command baselines for crash recovery, and
    // before manifests even when a retained preview refers to an older result.
    let expanded = true;
    while (expanded) {
      const size = keep.size;
      for (const { record } of manifests) {
        if (keep.has(record.id)) {
          if (record.beforeId) keep.add(record.beforeId);
          if (record.supersedesId) keep.add(record.supersedesId);
        }
        if (record.phase === "command" && record.beforeId && keep.has(record.beforeId)) keep.add(record.id);
      }
      expanded = keep.size !== size;
    }
    const referenced = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["hash", "contextHash", "contextBeforeHash"].includes(key) && typeof child === "string") referenced.add(child);
        else visit(child);
      }
    };
    const retainedEdits = new Set(edits.filter(item => keep.has(item.record.beforeId)).map(item => item.record.id));
    for (const [kind, records, retained] of [["manifests", manifests, keep], ["operations", operations, retainedOperations], ["plans", plans, new Set(retainedPlans.map(item => item.record.id))], ["edits", edits, retainedEdits]] as const) {
      for (const { name, record } of records) {
        if (retained.has(record.id)) visit(record); else await fs.unlink(path.join(this.directory, kind, name));
      }
    }
    const objects = await fs.readdir(path.join(this.directory, "objects")).catch(error => { if (hasCode(error, "ENOENT")) return []; throw error; });
    for (const hash of objects) if (/^[a-f0-9]{64}$/.test(hash) && !referenced.has(hash)) await fs.unlink(this.objectPath(hash));
  }
}

type ActiveHistory = {
  store: CheckpointStore; before: Checkpoint; tracked: Map<string, TrackedEdit>;
  pending: Map<string, EditRecord>; commands: Set<CommandFrame>; closing: boolean;
  status: "complete" | "incomplete"; releaseTurn: () => void; lastCheckpoint?: string;
  publishing: Promise<unknown>; unpin: () => void;
};
type CommandFrame = {
  history: WorkspaceCheckpoints; active: ActiveHistory; owner: object; id: string;
  before: Checkpoint; revisions: Map<string, string>; baselines: Map<string, { before: FileVersion; revision: string }>;
  parent?: CommandFrame; release: () => void; finishing?: Promise<void>; background: boolean; unpin: () => void;
  workspaceRevision: string;
  tracked: Map<string, TrackedEdit>;
};

/** Session-owned journals; only actual mutations acquire filesystem leases. */
export class WorkspaceCheckpoints {
  private active?: ActiveHistory;
  constructor(private readonly workspace: string, private readonly pilotHome: string) {}
  private frame(): CommandFrame | undefined {
    const frame = operationContext.getStore()?.command as CommandFrame | undefined;
    return frame?.history === this ? frame : undefined;
  }
  private current(): ActiveHistory | undefined { return this.frame()?.active ?? this.active; }
  async readVersion(filePath: string): Promise<string | undefined> {
    const active = this.current(), relative = await this.relativePath(filePath, active);
    return active && relative ? `${await active.store.scopeRevision()}/${await active.store.revision(relative)}` : undefined;
  }
  async beginTurn(sessionId: string, turnId: string, messages: CanonicalMessage[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CheckpointError("ABORTED", "Turn stopped before its checkpoint was captured.");
    const store = await getCheckpointStore(this.workspace, this.pilotHome);
    const releaseTurn = registerWorkspaceTurn(store.workspace, sessionId, turnId);
    const unpin = await store.pin();
    try {
      await store.recoverInterrupted(sessionId);
      const before: Checkpoint = { version: 1, journalVersion: 2, id: randomUUID(), sessionId, turnId, workspace: store.workspace,
        createdAt: new Date().toISOString(), phase: "before", status: "complete", files: {}, contextHash: await store.putObject(Buffer.from(JSON.stringify(messages))) };
      await store.save(before);
      this.active = { store, before, tracked: new Map(), pending: new Map(), commands: new Set(), closing: false, status: "complete", releaseTurn, unpin, publishing: Promise.resolve() };
    } catch (error) { unpin(); releaseTurn(); throw error; }
  }
  async runEdit<T>(filePath: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = operationContext.getStore()?.owner ?? {};
    const release = await acquireWorkspaceOperation(resolveRealWritePath(filePath) ?? filePath, { kind: "file", owner, signal, label: "正在写入项目文件" });
    try { return await operationContext.run({ ...operationContext.getStore(), owner }, task); }
    catch (error) {
      // A failed tool may have written bytes before its journal commit failed.
      // Keep that outcome reviewable, but never advertise it as safe to undo.
      const active = this.current(), relative = await this.relativePath(filePath, active);
      const edit = relative ? active?.pending.get(relative) : undefined;
      if (active && relative && edit) {
        try {
          edit.after = await active.store.captureFile(relative); edit.uncertain = true;
          await active.store.saveEdit(edit, true);
          active.pending.delete(relative);
          mergeTrackedEdit(this.frame()?.tracked ?? active.tracked, relative, edit);
        } catch { /* The prepared record remains available for crash recovery. */ }
      }
      throw error;
    }
    finally { release(); }
  }
  async runCommand<T>(task: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const frame = await this.startCommand(options);
    if (!frame) return task();
    try { return await operationContext.run({ owner: frame.owner, command: frame }, task); }
    finally { await this.finishCommand(frame); }
  }
  async trackEdit(filePath: string, _turnId: string, options: { allowUnprotected?: boolean } = {}): Promise<void> {
    const active = this.current(), relative = await this.relativePath(filePath, active);
    if (!active || !relative) return;
    const before = await active.store.captureFile(relative);
    if (before.kind === "unprotected" && !options.allowUnprotected) throw new CheckpointError("BACKUP_UNAVAILABLE", `Cannot protect ${relative}: ${before.reason}`);
    const revision = await active.store.revision(relative), frame = this.frame();
    if (frame && !frame.baselines.has(relative)) frame.baselines.set(relative, { before, revision });
    const edit: EditRecord = { id: randomUUID(), before, beforeRevision: revision, beforeId: active.before.id, path: relative,
      workspaceRevision: await active.store.scopeRevision(),
      sessionId: active.before.sessionId, turnId: active.before.turnId, createdAt: new Date().toISOString(), ...(frame ? { parentOperationId: frame.id } : {}) };
    await active.store.saveEdit(edit);
    active.pending.set(relative, edit);
  }
  async recordEdit(filePath: string, _turnId: string, writtenContent?: string): Promise<void> {
    const active = this.current(), relative = await this.relativePath(filePath, active);
    if (!active || !relative) return;
    const edit = active.pending.get(relative);
    if (!edit) return;
    edit.after = await active.store.captureFile(relative);
    if (writtenContent !== undefined) {
      const content = Buffer.from(writtenContent), disk = edit.after;
      edit.after = content.length > MAX_FILE_BYTES ? { kind: "unprotected", reason: "File exceeds the 10 MB checkpoint limit." } : {
        kind: "file", hash: await active.store.putObject(content), size: content.length, binary: content.includes(0),
        mode: disk.kind === "file" ? disk.mode : edit.before.kind === "file" ? edit.before.mode : 0o644,
        ...(disk.kind === "file" && disk.hash === digest(content) ? { fingerprint: disk.fingerprint } : {}) };
    }
    edit.source = "file_tool"; edit.afterRevision = edit.id;
    await active.store.saveEdit(edit, true);
    await active.store.advance(relative, edit.id);
    active.pending.delete(relative);
    mergeTrackedEdit(this.frame()?.tracked ?? active.tracked, relative, edit);
  }
  private merge(active: ActiveHistory, relative: string, edit: TrackedEdit): void {
    mergeTrackedEdit(active.tracked, relative, edit);
  }
  async trackCommand(options: { background?: boolean; signal?: AbortSignal } = {}): Promise<() => Promise<void>> {
    const frame = await this.startCommand(options);
    return frame ? () => this.finishCommand(frame) : async () => {};
  }
  private async startCommand(options: { background?: boolean; signal?: AbortSignal }): Promise<CommandFrame | undefined> {
    const active = this.current();
    if (!active) return;
    const owner = operationContext.getStore()?.owner ?? {};
    const release = await acquireWorkspaceOperation(active.store.workspace, { owner, signal: options.signal,
      label: options.background ? "等待后台写任务结束" : "等待项目命令执行完成" });
    const unpin = await active.store.pin();
    try {
      const before = await active.store.capture(active.before.sessionId, active.before.turnId, "command");
      before.beforeId = active.before.id;
      before.status = "incomplete";
      for (const relative of active.tracked.keys()) if (!scannedPath(relative)) before.files[relative] = await active.store.captureFile(relative);
      const revisions = new Map<string, string>();
      for (const relative of Object.keys(before.files)) revisions.set(relative, await active.store.revision(relative));
      await active.store.save(before);
      const frame: CommandFrame = { history: this, active, owner, id: before.id, before, revisions, baselines: new Map(), tracked: new Map(), parent: this.frame(), release, unpin, background: !!options.background, workspaceRevision: await active.store.scopeRevision() };
      active.commands.add(frame);
      return frame;
    } catch (error) { unpin(); release(); throw error; }
  }
  private finishCommand(frame: CommandFrame): Promise<void> {
    return frame.finishing ??= (async () => {
      const active = frame.active;
      try {
        const after = await active.store.capture(active.before.sessionId, active.before.turnId, "after");
        for (const relative of new Set([...active.tracked.keys(), ...frame.baselines.keys()])) if (!scannedPath(relative)) after.files[relative] = await active.store.captureFile(relative);
        const aliases = new Map<string, string>();
        for (const relative of new Set([...Object.keys(frame.before.files), ...Object.keys(after.files), ...frame.baselines.keys()])) aliases.set(relative, await active.store.normalizeFilePath(relative));
        const normalize = <T>(entries: Iterable<[string, T]>) => new Map([...entries].map(([relative, value]) => [aliases.get(relative) ?? relative, value]));
        const beforeFiles = normalize(Object.entries(frame.before.files)), afterFiles = normalize(Object.entries(after.files));
        const revisions = normalize(frame.revisions), baselines = normalize(frame.baselines), tracked = normalize(frame.tracked);
        for (const relative of new Set(aliases.values())) {
          const left = beforeFiles.get(relative) ?? baselines.get(relative)?.before ?? ABSENT, right = afterFiles.get(relative) ?? ABSENT;
          const beforeRevision = revisions.get(relative) ?? baselines.get(relative)?.revision ?? "";
          if (sameOnDisk(left, right) && !frame.baselines.has(relative) && beforeRevision === await active.store.revision(relative)) continue;
          const owned = tracked.get(relative);
          const attributable = owned && !owned.uncertain && sameOnDisk(left, owned.before) && sameOnDisk(right, owned.after ?? ABSENT)
            && beforeRevision === owned.beforeRevision && owned.afterRevision === await active.store.revision(relative)
            && frame.workspaceRevision === owned.workspaceRevision;
          const edit: EditRecord = { id: randomUUID(), beforeId: active.before.id, path: relative, before: left, after: right, beforeRevision,
            workspaceRevision: frame.workspaceRevision,
            source: attributable ? "file_tool" : "observed", createdAt: new Date().toISOString(), sessionId: active.before.sessionId, turnId: active.before.turnId,
            ...(frame.parent ? { parentOperationId: frame.parent.id } : {}), ...(!attributable || active.closing ? { uncertain: true } : {}) };
          edit.afterRevision = edit.id;
          await active.store.saveEdit(edit); await active.store.advance(relative, edit.id);
          if (!attributable && same(left, right)) continue;
          if (frame.parent) {
            if (!frame.parent.baselines.has(relative)) frame.parent.baselines.set(relative, { before: left, revision: beforeRevision });
            mergeTrackedEdit(frame.parent.tracked, relative, edit);
          } else this.merge(active, relative, edit);
        }
        frame.before.status = "complete";
        await active.store.save(frame.before, true);
        if (active.closing) await this.publish(active);
      } finally { active.commands.delete(frame); frame.unpin(); frame.release(); }
    })();
  }
  private async relativePath(filePath: string, active = this.current()): Promise<string | undefined> {
    if (!active) return;
    const target = resolveRealWritePath(filePath) ?? path.resolve(filePath), root = active.store.workspace, alias = path.resolve(this.workspace);
    const base = inside(root, target) ? root : inside(alias, target) ? alias : undefined;
    return base ? active.store.normalizeFilePath(path.relative(base, target).split(path.sep).join("/")) : undefined;
  }
  private async publish(active: ActiveHistory): Promise<CheckpointSummary> {
    const publishing = active.publishing.then(async () => {
      const after: Checkpoint = { ...active.before, id: randomUUID(), phase: "after", createdAt: new Date().toISOString(), contextHash: undefined,
        beforeId: active.before.id, status: active.status, files: {}, ...(active.lastCheckpoint ? { supersedesId: active.lastCheckpoint } : {}) };
      const pending = [...active.commands].some(frame => !frame.finishing);
      const tracked = pending ? new Map([...active.tracked].map(([relative, edit]) => [relative, { ...edit, uncertain: true }])) : active.tracked;
      after.changes = await active.store.changes(active.before, after, tracked);
      await active.store.save(after); active.lastCheckpoint = after.id;
      return active.store.summary(after);
    });
    active.publishing = publishing.catch(() => {});
    return publishing;
  }
  async finishTurn(status: "complete" | "incomplete"): Promise<CheckpointSummary | undefined> {
    const active = this.active;
    if (!active) return;
    await Promise.allSettled([...active.commands].flatMap(frame => frame.finishing ? [frame.finishing] : []));
    active.closing = true; active.status = status;
    try { return await this.publish(active); }
    finally {
      if (this.active === active) this.active = undefined;
      active.releaseTurn();
      active.unpin();
      await active.store.prune().catch(() => {});
    }
  }
}

function inside(root: string, target: string): boolean { const relative = path.relative(root, target); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  try { return realpathSync.native(absolute); } catch { return path.dirname(absolute) === absolute ? absolute : path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute)); }
}
function digest(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && error.code === code; }
function same(left: FileVersion, right: FileVersion): boolean { return left.kind === right.kind && (left.kind === "absent" || (left.kind === "file" && right.kind === "file" && left.hash === right.hash && left.mode === right.mode) || (left.kind === "unprotected" && right.kind === "unprotected" && !!left.fingerprint && left.fingerprint === right.fingerprint)); }
function scannedPath(relative: string): boolean { const segments = relative.split("/"); return !segments.slice(0, -1).some(segment => EXCLUDED.has(segment)) && segments.at(-1) !== ".git" && !segments.at(-1)?.startsWith(".pilotdeck-restore-"); }

function sameOnDisk(left: FileVersion, right: FileVersion): boolean { return same(left, right) && (left.kind !== "file" || right.kind !== "file" || !right.fingerprint || left.fingerprint === right.fingerprint); }
