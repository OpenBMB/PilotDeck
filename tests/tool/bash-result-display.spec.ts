import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import type { PilotDeckCommandRunner } from "../../src/tool/builtin/bash/commandRunner.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { toCanonicalToolResultBlock } from "../../src/tool/protocol/result.js";

function createRuntime(runner: PilotDeckCommandRunner): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner }));
  return new ToolRuntime(registry, new PermissionRuntime());
}

function context() {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  };
}

test("bash success result is formatted with assertions, stdout, and stderr", async () => {
  const runtime = createRuntime({
    async run() {
      return {
        exitCode: 0,
        stdout: "hello stdout\n",
        stderr: "warning stderr\n",
        timedOut: false,
        durationMs: 12,
      };
    },
  });

  const result = await runtime.execute(
    { id: "call-bash", name: "bash", input: { command: "echo hello" } },
    context(),
  );

  assert.equal(result.type, "success");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /BASH_RESULT\[success\]\[stdout_data\]/);
  assert.match(text, /stdout_visible: true/);
  assert.match(text, /stderr_visible: true/);
  assert.match(text, /stdout:\nhello stdout/);
  assert.match(text, /stderr:\nwarning stderr/);
});

test("bash allows hyphenated commands whose names merely start with next", async () => {
  const commands: string[] = [];
  const runtime = createRuntime({
    async run(command) {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: "bounded batch\n",
        stderr: "",
        timedOut: false,
        durationMs: 4,
      };
    },
  });

  for (const command of [
    "node legal-coverage.mjs next-batch --phase coverage",
    "./tools/next-batch --limit 12",
    "node scripts/next-batch.mjs",
  ]) {
    const result = await runtime.execute(
      { id: `call-${commands.length}`, name: "bash", input: { command } },
      context(),
    );
    assert.equal(result.type, "success", command);
  }

  assert.deepEqual(commands, [
    "node legal-coverage.mjs next-batch --phase coverage",
    "./tools/next-batch --limit 12",
    "node scripts/next-batch.mjs",
  ]);
});

test("bash still rejects exact framework CLI tokens that start long-lived processes", async () => {
  const commands: string[] = [];
  const runtime = createRuntime({
    async run(command) {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: "unexpected\n",
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  });

  for (const command of [
    "next dev",
    "npx next --host 127.0.0.1",
    "./node_modules/.bin/next start",
  ]) {
    const result = await runtime.execute(
      { id: `call-${command}`, name: "bash", input: { command } },
      context(),
    );
    assert.equal(result.type, "error", command);
    if (result.type === "error") {
      assert.equal(result.error.code, "invalid_tool_input");
      assert.match(result.error.message, /long-lived server, watcher, or dev process/u);
    }
  }

  assert.deepEqual(commands, [], "rejected framework commands must not reach the shell runner");
});

test("bash failure tool result includes raw stdout and stderr tail for UI and model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-bash-error-budget-"));
  const stderrTail = "TAIL ROOT CAUSE: missing package @example/pkg";
  try {
    const runtime = createRuntime({
      async run() {
        return {
          exitCode: 1,
          stdout: `stdout start\n${"o".repeat(9000)}\nstdout tail`,
          stderr: `stderr start\n${"e".repeat(260_000)}\n${stderrTail}`,
          timedOut: false,
          durationMs: 34,
        };
      },
    });

    const result = await runtime.execute(
      { id: "call-bash", name: "bash", input: { command: "npm test" } },
      context(),
    );

    assert.equal(result.type, "error");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /TOOL_ERROR\[tool_execution_failed\]\[bash\]/);
    assert.match(text, /Raw tool details:/);
    assert.match(text, /Diagnostic:/);
    assert.match(text, /BASH_FAILURE_DIAGNOSTIC/);
    assert.match(text, /- command: npm test/);
    assert.match(text, /- exit_code: 1/);
    assert.match(text, /stdout:/);
    assert.match(text, /stderr:/);
    assert.match(text, new RegExp(stderrTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const budget = new ToolResultBudget({
      toolResultsDir: dir,
      maxResultSizeChars: 50_000,
      maxResultSizeTokens: 2_000,
      previewBytes: 2_000,
    });
    const applied = await budget.applyToMessage({
      role: "user",
      content: [toCanonicalToolResultBlock(result)],
    }, { turnId: "turn-1" });

    const ref = applied.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected large bash error output to be persisted for read_file");
    assert.equal(ref.isError, true);
    const persisted = await readFile(ref.path, "utf8");
    assert.match(persisted, /stderr start/);
    assert.match(persisted, new RegExp(stderrTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash failure diagnostic extracts Python traceback location and exception", async () => {
  const runtime = createRuntime({
    async run() {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Traceback (most recent call last):\n  File "/tmp_workspace/script.py", line 7, in <module>\n    main()\n  File "/tmp_workspace/script.py", line 3, in main\n    raise TypeError("bad frame")\nTypeError: bad frame\n`,
        timedOut: false,
        durationMs: 9,
      };
    },
  });

  const result = await runtime.execute(
    { id: "call-bash", name: "bash", input: { command: "python3 script.py" } },
    context(),
  );

  assert.equal(result.type, "error");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /BASH_FAILURE_DIAGNOSTIC/);
  assert.match(text, /likely_cause: TypeError: bad frame/);
  assert.match(text, /failing_location: \/tmp_workspace\/script\.py:3 in main/);
});

test("bash success keeps full output for ToolResultBudget persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-bash-budget-"));
  const tail = "TAIL IMPORTANT SUCCESS MARKER";
  try {
    const runtime = createRuntime({
      async run() {
        return {
          exitCode: 0,
          stdout: `stdout start\n${"x".repeat(260_000)}\n${tail}`,
          stderr: "",
          timedOut: false,
          durationMs: 56,
        };
      },
    });

    const result = await runtime.execute(
      { id: "call-bash", name: "bash", input: { command: "cat huge.log" } },
      context(),
    );

    assert.equal(result.type, "success");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, new RegExp(tail));
    assert.equal(result.metadata?.truncated, undefined);
    assert.ok(result.metadata?.previewLimit, "expected preview limit metadata without truncating canonical content");

    const budget = new ToolResultBudget({
      toolResultsDir: dir,
      maxResultSizeChars: 50_000,
      maxResultSizeTokens: 2_000,
      previewBytes: 2_000,
    });
    const applied = await budget.applyToMessage({
      role: "user",
      content: [toCanonicalToolResultBlock(result)],
    }, { turnId: "turn-1" });

    const ref = applied.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected large bash output to be persisted for read_file");
    const persisted = await readFile(ref.path, "utf8");
    assert.match(persisted, /stdout start/);
    assert.match(persisted, new RegExp(tail));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
