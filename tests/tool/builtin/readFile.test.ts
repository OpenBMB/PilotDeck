import assert from "node:assert/strict";
import test from "node:test";
import { createReadFileTool } from "../../../src/tool/builtin/readFile.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const context = {
  sessionId: "test-session",
  turnId: "test-turn",
  cwd: "/tmp",
  permissionMode: "default",
  permissionContext: {},
} as unknown as PilotDeckToolRuntimeContext;

test("read_file treats an empty pages string as omitted", async () => {
  const tool = createReadFileTool();

  const result = await tool.validateInput?.({
    file_path: "notes.txt",
    pages: "",
  }, context);

  assert.deepEqual(result, {
    ok: true,
    input: {
      file_path: "notes.txt",
    },
  });
});
