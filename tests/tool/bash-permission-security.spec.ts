import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBashPermission,
  isReadOnlyShellCommand,
} from "../../src/tool/builtin/bash/permissions.js";

test("quoted catastrophic recursive delete targets are hard denied", () => {
  const commands = [
    "rm -rf '/'",
    'rm --recursive \"/etc\"',
    "rm -r '$HOME'",
    'rm -rf \"${HOME}/\"',
    "echo ok && rm -rf '/var/'",
  ];

  for (const command of commands) {
    assert.equal(classifyBashPermission(command).type, "deny", command);
  }

  assert.equal(classifyBashPermission("rm -rf './build'").type, "ask");
});

test("git repository context options never inherit read-only status", () => {
  const commands = [
    "git -C /tmp status",
    "git -C/tmp status",
    "git --git-dir .git status",
    "git --git-dir=.git status",
    "git --work-tree /tmp status",
    "git --work-tree=/tmp status",
  ];

  for (const command of commands) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
    assert.equal(classifyBashPermission(command).type, "ask", command);
  }

  assert.equal(isReadOnlyShellCommand("git status"), true);
  assert.equal(isReadOnlyShellCommand("git --namespace readonly status"), true);
});
