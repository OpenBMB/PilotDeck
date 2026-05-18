import test from "node:test";
import assert from "node:assert/strict";
import { createGlobTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("glob matches files with stable sorted results and limit", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/b.ts": "b",
    "src/a.ts": "a",
    "src/c.js": "c",
    "node_modules/ignored.ts": "ignored",
    "dist/ignored.ts": "ignored",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "glob", input: { pattern: "**/*.ts", limit: 1 } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, { files: ["src/a.ts"], count: 2, truncated: true });
});

test("glob preserves workspace-relative prefixes and forward slashes", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/nested/a.ts": "a",
    "src/nested/b.ts": "b",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "glob", input: { pattern: "**/*.ts", path: "src" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, {
    files: ["src/nested/a.ts", "src/nested/b.ts"],
    count: 2,
    truncated: false,
  });
});

test("glob denies path outside workspace", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "glob", input: { pattern: "**/*", path: "../" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "path_not_allowed");
});

test("glob reports unsupported_tool when ripgrep is unavailable", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/a.ts": "a",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGlobTool()],
    cwd: workspace.cwd,
  });
  context.env = {
    ...process.env,
    PATH: "",
    Path: "",
  };

  const result = await toolRuntime.execute(
    { id: "call-1", name: "glob", input: { pattern: "**/*.ts" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "unsupported_tool");
    assert.match(result.error.message, /ripgrep/i);
  }
});
