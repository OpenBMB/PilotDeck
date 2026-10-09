import assert from "node:assert/strict";
import test, { before } from "node:test";
import { matchPermissionRule } from "../../src/permission/policy/matchPermissionRule.js";
import type { PermissionRule } from "../../src/permission/protocol/types.js";
import { preloadBashParser } from "../../src/tool/builtin/bash/parser.js";

before(async () => {
  await preloadBashParser();
});

function rule(behavior: PermissionRule["behavior"], pattern: string): PermissionRule {
  return { source: "user", behavior, toolName: "bash", pattern };
}

function matches(target: PermissionRule, command: string): boolean {
  return matchPermissionRule(target, "bash", { command });
}

test("an allow rule must cover every command in the script", () => {
  const allowNpm = rule("allow", "npm:*");
  assert.equal(matches(allowNpm, "npm test"), true);
  assert.equal(matches(allowNpm, "npm test && npm run lint"), true);
  for (const command of [
    "npm test && rm -rf ./src",
    "npm test; rm -rf /",
    "npm test\nrm -rf ./src",
    "npm test | sh",
    "npm test $(rm -rf ./src)",
    "FOO=1 npm test",
    "npm test 'unterminated",
  ]) {
    assert.equal(matches(allowNpm, command), false, command);
  }
});

test("ask and deny rules match when any command matches", () => {
  for (const behavior of ["ask", "deny"] as const) {
    const rmRule = rule(behavior, "rm:*");
    assert.equal(matches(rmRule, "rm -rf ./build"), true);
    assert.equal(matches(rmRule, "echo hi && rm -rf ./build"), true);
    assert.equal(matches(rmRule, "echo hi\nrm -rf ./build"), true);
    assert.equal(matches(rmRule, "echo \"$(rm -rf ./build)\""), true);
    assert.equal(matches(rmRule, "echo rm"), false);
  }
});
