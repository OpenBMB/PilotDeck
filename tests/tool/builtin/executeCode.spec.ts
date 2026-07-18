import assert from "node:assert/strict";
import test from "node:test";

import { createExecuteCodeTool } from "../../../src/tool/builtin/executeCode.js";

test("execute_code read-only probe handles missing input", () => {
  const tool = createExecuteCodeTool();

  assert.equal(tool.isReadOnly({} as never), false);
});
