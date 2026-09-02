import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePermissionSettings,
  permissionSettingsToRuleSet,
} from "../../src/permission/settings.js";

test("normalizes and maps explicit confirmation rules", () => {
  const settings = normalizePermissionSettings({
    allowedTools: ["Read"],
    askTools: ["Bash(rm:*)", "Bash(rm:*)"],
    disallowedTools: ["Write"],
    skipPermissions: false,
  });

  assert.deepEqual(settings.askTools, ["bash:rm:*"]);
  assert.deepEqual(permissionSettingsToRuleSet(settings), {
    allow: [{ source: "user", behavior: "allow", toolName: "read_file", pattern: undefined }],
    ask: [{ source: "user", behavior: "ask", toolName: "bash", pattern: "rm:*" }],
    deny: [{ source: "user", behavior: "deny", toolName: "write_file", pattern: undefined }],
  });
});

test("keeps older permission files compatible when askTools is absent", () => {
  const settings = normalizePermissionSettings({
    allowedTools: ["read_file"],
    disallowedTools: ["write_file"],
  });

  assert.deepEqual(settings.askTools, []);
});
