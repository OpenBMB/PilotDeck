import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultPermissionContext, normalizeSudoPermissionPolicy, PermissionRuntime } from "../../../src/permission/index.js";
import type { SudoPermissionPolicy } from "../../../src/permission/index.js";
import { createBashTool } from "../../../src/tool/builtin/bash.js";
import { classifyBashPermission } from "../../../src/tool/builtin/bash/permissions.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/index.js";

test("sudo is denied by default", () => {
  const result = classifyBashPermission("sudo systemctl restart nginx");

  assert.equal(result.type, "deny");
  if (result.type !== "deny") return;
  assert.match(result.message, /local machine/);
});

test("local sudo policy can ask instead of hard denying", () => {
  const result = classifyBashPermission("sudo systemctl restart nginx", sudoPolicy({
    local: "ask",
    remote: "deny",
    remoteHosts: [],
  }));

  assert.equal(result.type, "ask");
  if (result.type !== "ask") return;
  assert.match(result.request.inputSummary, /sudo systemctl/);
  assert.deepEqual(result.request.metadata?.sudo, {
    scope: "local",
    host: undefined,
    action: "ask",
  });
});

test("remote sudo can be allowed while local sudo stays denied", () => {
  const policy = sudoPolicy({
    local: "deny",
    remote: "allow",
    remoteHosts: [],
  });

  assert.equal(classifyBashPermission("ssh web-1 'sudo systemctl restart nginx'", policy).type, "allow");

  const local = classifyBashPermission("ssh web-1 'sudo true'; sudo whoami", policy);
  assert.equal(local.type, "deny");
  if (local.type !== "deny") return;
  assert.match(local.message, /local machine/);
});

test("remote sudo allow does not auto-allow unrelated local side effects", () => {
  const result = classifyBashPermission("ssh web-1 'sudo true'; mkdir local-output", sudoPolicy({
    local: "deny",
    remote: "allow",
    remoteHosts: [],
  }));

  assert.equal(result.type, "ask");
  if (result.type !== "ask") return;
  assert.match(result.request.inputSummary, /mkdir local-output/);
});

test("remote host overrides take precedence over the remote default", () => {
  const result = classifyBashPermission("ssh deploy@prod-01 sudo systemctl restart nginx", sudoPolicy({
    local: "deny",
    remote: "allow",
    remoteHosts: [
      { host: "prod-*", action: "deny" },
    ],
  }));

  assert.equal(result.type, "deny");
  if (result.type !== "deny") return;
  assert.match(result.message, /remote host deploy@prod-01/);
});

test("remote host overrides normalize conflicting duplicate hosts", () => {
  const policy = normalizeSudoPermissionPolicy({
    local: "deny",
    remote: "ask",
    remoteHosts: [
      { host: "Prod-*", action: "allow" },
      { host: " prod-* ", action: "deny" },
      { host: "stage-*", action: "ask" },
    ],
  });

  assert.deepEqual(policy.remoteHosts, [
    { host: "Prod-*", action: "allow" },
    { host: "stage-*", action: "ask" },
  ]);

  const result = classifyBashPermission("ssh deploy@prod-01 sudo systemctl restart nginx", policy);
  assert.equal(result.type, "allow");
});

test("remote sudo detection handles ssh executable paths", () => {
  const result = classifyBashPermission("/usr/bin/ssh ops@web-2 sudo systemctl restart nginx", sudoPolicy({
    local: "deny",
    remote: "allow",
    remoteHosts: [],
  }));

  assert.equal(result.type, "allow");
});

test("remote sudo is detected in ssh heredoc scripts", () => {
  const result = classifyBashPermission([
    "ssh ubuntu@10.0.0.5 <<'EOF'",
    "sudo apt-get update",
    "EOF",
  ].join("\n"), sudoPolicy({
    local: "deny",
    remote: "ask",
    remoteHosts: [
      { host: "10.0.0.*", action: "allow" },
      { host: "prod-*", action: "deny" },
    ],
  }));

  assert.equal(result.type, "allow");
});

test("sudo policy denial wins over broad bash allow rules", async () => {
  const runtime = new PermissionRuntime();
  const tool = createBashTool();
  const decision = await runtime.decide(
    tool,
    { command: "sudo whoami" },
    runtimeContext({
      local: "deny",
      remote: "deny",
      remoteHosts: [],
    }),
    "tool-call-1",
  );

  assert.equal(decision.type, "deny");
  if (decision.type !== "deny") return;
  assert.match(decision.message, /local machine/);
});

function sudoPolicy(value: SudoPermissionPolicy): SudoPermissionPolicy {
  return value;
}

function runtimeContext(sudoPolicy: SudoPermissionPolicy): PilotDeckToolRuntimeContext {
  const cwd = process.cwd();
  const permissionContext = createDefaultPermissionContext({
    cwd,
    canPrompt: true,
    rules: {
      allow: [
        {
          source: "user",
          behavior: "allow",
          toolName: "bash",
          pattern: "*",
        },
      ],
    },
    sudoPolicy,
  });

  return {
    sessionId: "test-session",
    turnId: "test-turn",
    cwd,
    permissionMode: permissionContext.mode,
    permissionContext,
  };
}
