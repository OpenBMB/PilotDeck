import test from "node:test";
import assert from "node:assert/strict";
import { isIgnoredExtensionRuntimePath } from "../../src/cli/ExtensionWatchManager.js";

test("extension watcher ignores generated Python and Office runtime files", () => {
  for (const path of [
    "/repo/skills/docx/scripts/docxlib/__pycache__/core.cpython-313.pyc",
    "/repo/skills/docx/scripts/docxlib/helper.pyo",
    "/repo/skills/docx/.DS_Store",
    "/repo/skills/docx/.~lock.report.docx#",
    "C:\\repo\\skills\\docx\\~$report.docx",
  ]) {
    assert.equal(isIgnoredExtensionRuntimePath(path), true, path);
  }
  assert.equal(isIgnoredExtensionRuntimePath("/repo/skills/docx/SKILL.md"), false);
  assert.equal(isIgnoredExtensionRuntimePath("/repo/skills/docx/scripts/docx_cli.py"), false);
});
