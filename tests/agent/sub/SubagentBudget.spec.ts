import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SUBAGENT_PARENT_HANDOFF_RESERVE_MS,
  SubagentTimeoutError,
  appendSubagentBudgetDirective,
  awaitSubagentOperation,
  composeSubagentAbortSignal,
  resolveSubagentExecutionBudget,
} from "../../../src/agent/sub/SubagentBudget.js";

test("subagent budget defaults to ten minutes without a parent deadline", () => {
  assert.deepEqual(resolveSubagentExecutionBudget({}), {
    timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    configuredTimeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    parentBounded: false,
  });
});

test("subagent budget preserves the parent handoff window", () => {
  const nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  assert.deepEqual(resolveSubagentExecutionBudget({
    configuredTimeoutMs: 120_000,
    parentDeadlineAtMs: nowMs + 90_000,
    nowMs,
  }), {
    timeoutMs: 60_000,
    configuredTimeoutMs: 120_000,
    parentBounded: true,
  });
  assert.equal(resolveSubagentExecutionBudget({
    configuredTimeoutMs: 120_000,
    parentDeadlineAtMs: nowMs + SUBAGENT_PARENT_HANDOFF_RESERVE_MS,
    nowMs,
  }), undefined);
});

test("subagent budget directive exposes the effective bound and diminishing-return rule", () => {
  const directive = appendSubagentBudgetDirective("Inspect the sources.", {
    timeoutMs: 60_000,
    configuredTimeoutMs: 120_000,
    parentBounded: true,
  });

  assert.match(directive, /^Inspect the sources\./u);
  assert.match(directive, /Hard wall-clock budget: 60 seconds\./u);
  assert.match(directive, /explicit gaps instead of cycling through equivalent alternatives/u);
});

test("composed subagent timeout aborts with a typed reason", async () => {
  const scope = composeSubagentAbortSignal({ timeoutMs: 5 });
  try {
    await new Promise<void>((resolve) => {
      scope.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    assert.equal(scope.timedOut(), true);
    assert.ok(scope.signal.reason instanceof SubagentTimeoutError);
    assert.equal(scope.signal.reason.timeoutMs, 5);
  } finally {
    scope.cleanup();
  }
});

test("subagent operation returns control even when the callee ignores abort", async () => {
  const scope = composeSubagentAbortSignal({ timeoutMs: 5 });
  try {
    await assert.rejects(
      awaitSubagentOperation(new Promise<never>(() => {}), scope.signal),
      (error: unknown) => error instanceof SubagentTimeoutError,
    );
    assert.equal(scope.timedOut(), true);
  } finally {
    scope.cleanup();
  }
});

test("parent abort wins without being misclassified as a child timeout", async () => {
  const parent = new AbortController();
  const reason = new Error("parent turn aborted");
  const scope = composeSubagentAbortSignal({ parent: parent.signal, timeoutMs: 60_000 });
  try {
    const pending = assert.rejects(
      awaitSubagentOperation(new Promise<never>(() => {}), scope.signal),
      (error: unknown) => error === reason,
    );
    parent.abort(reason);
    await pending;
    assert.equal(scope.timedOut(), false);
  } finally {
    scope.cleanup();
  }
});
