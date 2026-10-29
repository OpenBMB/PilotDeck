import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CheckpointError, getCheckpointStore, WorkspaceCheckpoints } from "./WorkspaceCheckpoints.js";
import type { CheckpointRequest } from "./types.js";
const requests = new Map<string, AbortController>();

/** All Web file mutations execute in the Gateway, alongside agent operations. */
export async function runWorkspaceFileOperation(root: string, pilotHome: string, input: CheckpointRequest["fileOperation"]) {
  if (!input || !["save", "create", "mkdir", "rename", "delete", "upload"].includes(input.operation)) throw new CheckpointError("INVALID_ACTION", "Invalid file operation.");
  const store = await getCheckpointStore(root, pilotHome);
  if (input.requestId !== undefined && !/^[a-f0-9-]{36}$/.test(input.requestId)) throw new CheckpointError("INVALID_ID", "Invalid file request.");
  const requestKey = `${store.workspace}\0${input.requestId ?? randomUUID()}`;
  if (input.cancel) {
    let pending = requests.get(requestKey);
    if (!pending) {
      pending = new AbortController(); requests.set(requestKey, pending);
      const cancelled = pending;
      setTimeout(() => { if (requests.get(requestKey) === cancelled) requests.delete(requestKey); }, 60_000).unref();
    }
    pending.abort(); return { success: true };
  }
  if (requests.get(requestKey)?.signal.aborted) { requests.delete(requestKey); throw new CheckpointError("ABORTED", "File request cancelled."); }
  if (requests.has(requestKey)) throw new CheckpointError("DUPLICATE_REQUEST", "File request already running.");
  const relative = (value: string) => {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new CheckpointError("INVALID_PATH", "Invalid project file path.");
    return path.isAbsolute(value) ? path.relative(store.workspace, value).split(path.sep).join("/") : value;
  };
  const name = await store.normalizeFilePath(relative(input.path));
  const target = await store.resolveFile(name);
  // User changes have their own journal identity and never become agent edits.
  const history = new WorkspaceCheckpoints(store.workspace, pilotHome);
  const turnId = randomUUID();
  const controller = new AbortController();
  // Path validation above awaits I/O; a cancellation can arrive during it.
  const registered = requests.get(requestKey);
  if (registered?.signal.aborted) { requests.delete(requestKey); throw new CheckpointError("ABORTED", "File request cancelled."); }
  if (registered) throw new CheckpointError("DUPLICATE_REQUEST", "File request already running.");
  requests.set(requestKey, controller);
  let complete = false;
  try {
    await history.beginTurn("filesystem:user", turnId, [], controller.signal);
    const fileMutation = ["save", "create", "upload"].includes(input.operation);
    const mutate = async () => {
      controller.signal.throwIfAborted();
      await store.resolveFile(name);
      const info = await fs.lstat(target).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (fileMutation) await history.trackEdit(target, turnId);
      if (input.operation === "save") {
        if (typeof input.content !== "string") throw new CheckpointError("INVALID_CONTENT", "File content is required.");
        const before = await store.captureFile(name, false);
        const expected = input.expectedHash ?? (input.expectedContent === undefined ? undefined : createHash("sha256").update(input.expectedContent).digest("hex"));
        if (expected !== undefined && (before.kind !== "file" || before.hash !== expected)) throw new CheckpointError("FILE_CHANGED", "文件已被修改，请重新读取后再保存。");
        const temporary = path.join(path.dirname(target), `.pilotdeck-restore-${randomUUID()}`);
        try {
          await fs.writeFile(temporary, input.content, { flag: "wx", mode: info?.mode ?? 0o644 });
          if (info) await fs.rename(temporary, target); else await fs.link(temporary, target);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      } else if (input.operation === "create") {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "", { flag: "wx" });
      } else if (input.operation === "mkdir") {
        await fs.mkdir(target);
      } else if (input.operation === "rename") {
        const destination = await store.resolveFile(await store.normalizeFilePath(relative(input.newPath ?? "")));
        if (await fs.lstat(destination).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) throw new CheckpointError("FILE_EXISTS", "Destination already exists.");
        await fs.rename(target, destination);
      } else if (input.operation === "delete") {
        if (!info) throw Object.assign(new Error("File not found."), { code: "ENOENT" });
        if (info.isDirectory()) await fs.rm(target, { recursive: true }); else await fs.unlink(target);
      } else if (input.operation === "upload") {
        const staged = relative(input.stagedPath ?? "");
        if (!staged.startsWith(".tmp/workspace-upload-")) throw new CheckpointError("INVALID_PATH", "Invalid staged upload.");
        const source = await store.resolveFile(staged);
        if (!(await fs.lstat(source)).isFile()) throw new CheckpointError("INVALID_PATH", "Invalid staged upload.");
        await fs.mkdir(path.dirname(target), { recursive: true });
        // A temporary sibling keeps publication atomic even across filesystems.
        const temporary = path.join(path.dirname(target), `.pilotdeck-restore-${randomUUID()}`);
        try { await fs.copyFile(source, temporary, constants.COPYFILE_EXCL); await fs.link(temporary, target); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      }
      if (fileMutation) await history.recordEdit(target, turnId, input.operation === "save" ? input.content : undefined);
    };
    if (fileMutation) await history.runEdit(target, mutate, controller.signal); else await history.runCommand(mutate, { signal: controller.signal });
    complete = true;
    return { success: true, path: target, ...(input.operation === "save" ? { hash: createHash("sha256").update(input.content!).digest("hex") } : {}) };
  } finally { requests.delete(requestKey); await history.finishTurn(complete ? "complete" : "incomplete"); }
}
