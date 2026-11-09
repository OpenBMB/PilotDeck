import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceCheckpoints, getCheckpointStore } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { resolveDefaultCommandShell } from "../../src/runtime/commandShell.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

export async function fixture(t: test.TestContext, initialFiles: Record<string, string> = {}) {
  // Detached children and task wait timers are unref'ed in the server runtime.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const base = await mkdtemp(join(tmpdir(), "checkpoint-execution-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace"), home = join(base, "home");
  await mkdir(workspace); await mkdir(home);
  const history = new WorkspaceCheckpoints(workspace, home), store = await getCheckpointStore(workspace, home);
  const context: PilotDeckToolRuntimeContext = {
    cwd: workspace, env: process.env, sessionId: "session", turnId: "turn", fileHistory: history,
    permissionMode: "bypassPermissions", permissionContext: { mode: "bypassPermissions", cwd: workspace,
      additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } },
  };
  context.executeTool = async call => {
    const input = call.input as { file_path: string; content: string };
    const output = call.name === "read_file" ? await createReadFileTool().execute(input, context)
      : call.name === "write_file" ? await createWriteFileTool().execute(input, context) : assert.fail(`Unexpected nested tool ${call.name}`);
    return { ...output, toolCallId: call.id, toolName: call.name, type: "success", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  };
  const file = join(workspace, "a.txt"); await writeFile(file, "A");
  for (const [relative, content] of Object.entries(initialFiles)) {
    await mkdir(dirname(join(workspace, relative)), { recursive: true });
    await writeFile(join(workspace, relative), content);
  }
  await history.beginTurn("session", "turn", []);
  const toolWrite = async (content: string) => {
    await createReadFileTool().execute({ file_path: "a.txt" }, context);
    await createWriteFileTool().execute({ file_path: "a.txt", content }, context);
  };
  return { workspace, home, history, store, context, file, toolWrite };
}

export async function assertRestorable(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
  const checkpoint = (await f.history.finishTurn("complete"))!;
  const diff = await f.store.diff("session", checkpoint.id, "a.txt");
  assert.equal(diff.oldContent, "A"); assert.equal(diff.newContent, expected);
  const plan = await f.store.preview("session", checkpoint.id);
  assert.equal(plan.files[0].status, "ready");
  const operation = await f.store.restore("session", plan.id);
  assert.equal(await readFile(f.file, "utf8"), "A");
  await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
  assert.equal(await readFile(f.file, "utf8"), expected);
}

export async function assertUnattributed(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.equal((await f.store.diff("session", checkpoint.id, "a.txt")).newContent, expected);
  const plan = await f.store.preview("session", checkpoint.id);
  assert.equal(plan.files[0].status, "unprotected");
  assert.deepEqual((await f.store.restore("session", plan.id)).applied, []);
  assert.equal(await readFile(f.file, "utf8"), expected);
}

export function nodeCommand(code: string) {
  const shell = resolveDefaultCommandShell();
  return `${shell.kind === "pwsh" ? "& " : ""}"${process.execPath.replaceAll("\\", "/")}" -e "${code}"`;
}
