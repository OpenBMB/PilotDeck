import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecuteCodeTool } from "../../src/tool/builtin/executeCode.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { fixture, assertRestorable, assertUnattributed } from "./checkpoint-execution-fixture.js";

test("unattributed writes after nested tools are visible but cannot overwrite files through undo", async t => {
  const internal = ".pilotdeck/work/a.txt";
  const f = await fixture(t, { [internal]: "A" });
  await f.toolWrite("B");
  await createReadFileTool().execute({ file_path: internal }, f.context);
  await createWriteFileTool().execute({ file_path: internal, content: "B" }, f.context);
  const result = await createExecuteCodeTool().execute({ code: `from pathlib import Path
from pilotdeck_tools import read_file, write_file
for name in ['a.txt', '${internal}']:
    read_file(name)
    write_file(name, 'C')
    Path(name).write_text('B')
for name in ['temporary.txt', '.pilotdeck/work/temporary.txt']:
    write_file(name, 'temporary')
    Path(name).unlink()
` }, f.context);
  assert.equal(result.data!.status, "success", result.data!.error);
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.deepEqual(checkpoint.changes.map(change => change.path).sort(), [internal, "a.txt"].sort());
  for (const relative of ["a.txt", internal]) {
    const diff = await f.store.diff("session", checkpoint.id, relative);
    assert.equal(diff.oldContent, "A"); assert.equal(diff.newContent, "B");
  }
  const plan = await f.store.preview("session", checkpoint.id);
  assert.ok(plan.files.every(file => file.status === "conflict"), JSON.stringify(plan.files));
  const restored = await f.store.restore("session", plan.id);
  assert.deepEqual(restored.applied, []);
  for (const relative of ["a.txt", internal]) assert.equal(await readFile(join(f.workspace, relative), "utf8"), "B");
  for (const relative of ["temporary.txt", ".pilotdeck/work/temporary.txt"]) {
    await assert.rejects(readFile(join(f.workspace, relative)), { code: "ENOENT" });
  }
});

test("nested tools returning to the turn baseline leave no net changes", async t => {
  const internal = ".pilotdeck/work/a.txt", f = await fixture(t, { [internal]: "A" });
  const result = await createExecuteCodeTool().execute({ code: `from pathlib import Path
from pilotdeck_tools import read_file, write_file
for name in ['a.txt', '${internal}']:
    read_file(name)
    write_file(name, 'C')
    Path(name).write_text('A')
for name in ['temporary.txt', '.pilotdeck/work/temporary.txt']:
    write_file(name, 'temporary')
    Path(name).unlink()
` }, f.context);
  assert.equal(result.data!.status, "success", result.data!.error);
  assert.deepEqual((await f.history.finishTurn("complete"))!.changes, []);
});

test("returning execution still protects later manual edits", async t => {
  const f = await fixture(t); await f.toolWrite("B");
  const result = await createExecuteCodeTool().execute({ code: "from pathlib import Path\nfrom pilotdeck_tools import read_file, write_file\nread_file('a.txt')\nwrite_file('a.txt','C')\nPath('a.txt').write_text('B')" }, f.context);
  assert.equal(result.data!.status, "success", result.data!.error);
  await writeFile(f.file, "manual");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.equal((await f.store.diff("session", checkpoint.id, "a.txt")).newContent, "B");
  const plan = await f.store.preview("session", checkpoint.id);
  assert.equal(plan.files[0].status, "conflict");
  await f.store.restore("session", plan.id);
  assert.equal(await readFile(f.file, "utf8"), "manual");
});

test("execute_code with a complete nested file-tool chain remains safely restorable", async t => {
  const f = await fixture(t); await f.toolWrite("B");
  const result = await createExecuteCodeTool().execute({ code: "from pilotdeck_tools import read_file, write_file\nread_file('a.txt')\nwrite_file('a.txt', 'C')" }, f.context);
  assert.equal(result.data!.status, "success", result.data!.error);
  await assertRestorable(f, "C");
});

for (const order of ["python-tool", "tool-python", "nested-tools", "failed-python"]) {
  test(`execute_code ${order} retains observed changes without automatic undo`, async t => {
    const f = await fixture(t);
    if (order !== "python-tool") await f.toolWrite("B");
    const code = "from pathlib import Path\nPath('a.txt').write_text('C')\n" +
      (order === "nested-tools" ? "from pilotdeck_tools import read_file, write_file\nread_file('a.txt')\nwrite_file('a.txt', 'D')\nPath('a.txt').write_text('E')\n" :
        order === "failed-python" ? "raise RuntimeError('intentional failure')\n" : "");
    const result = await createExecuteCodeTool().execute({ code, timeout_seconds: 10 }, f.context);
    assert.equal(result.data!.status, order === "failed-python" ? "error" : "success", result.data!.error);
    if (order === "python-tool") await f.toolWrite("D");
    await assertUnattributed(f, order === "nested-tools" ? "E" : order === "python-tool" ? "D" : "C");
  });
}

test("Python execution preserves manual edits before and after its tracked writes", async t => {
  for (const timing of ["before", "after"]) {
    const f = await fixture(t); await f.toolWrite("B");
    if (timing === "before") await writeFile(f.file, "manual");
    assert.equal((await createExecuteCodeTool().execute({ code: "from pathlib import Path\nPath('a.txt').write_text('C')" }, f.context)).data!.status, "success");
    if (timing === "after") await writeFile(f.file, "manual");
    const checkpoint = (await f.history.finishTurn("complete"))!;
    const plan = await f.store.preview("session", checkpoint.id);
    assert.equal(plan.files[0].status, "unprotected");
    await f.store.restore("session", plan.id);
    assert.equal(await readFile(f.file, "utf8"), timing === "after" ? "manual" : "C");
  }
});
