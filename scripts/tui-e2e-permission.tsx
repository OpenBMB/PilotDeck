/**
 * End-to-end smoke test for TUI permission prompt.
 *
 * Uses `ink-testing-library` to render `TuiApp` with a **mock Gateway**
 * that deterministically emits `permission_request` events. Zero external
 * dependencies — no model API, no server, runs in ~3 seconds.
 *
 * Covers: y (allow once), a (allow + remember), n (deny), Esc (abort).
 *
 * Usage:
 *   npx tsx scripts/tui-e2e-permission.tsx
 */
import React from "react";
import { render } from "ink-testing-library";
import { TuiApp } from "../src/adapters/channel/tui/app/TuiApp.js";
import { readPermissionSettings, writePermissionSettings } from "../src/permission/settings.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../src/gateway/index.js";

// ──────────────── Mock Gateway ────────────────

type PendingPermission = {
  resolve: (d: { decision: "allow" | "deny"; remember?: boolean; reason?: string }) => void;
};

const noop = async () => {};
const stub = <T,>(v: T) => async () => v;

class MockGateway implements Gateway {
  private pending = new Map<string, PendingPermission>();
  private aborted = false;

  async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    this.aborted = false;
    yield { type: "turn_started", runId: "run-1" };

    const requestId = `perm-${Date.now()}`;
    const decisionPromise = new Promise<{ decision: "allow" | "deny"; remember?: boolean; reason?: string }>((resolve) => {
      this.pending.set(requestId, { resolve });
    });

    yield {
      type: "permission_request",
      requestId,
      toolName: "dangerous_action",
      payload: { action: input.message },
    };

    const decision = await decisionPromise;
    this.pending.delete(requestId);

    if (this.aborted) {
      yield { type: "turn_completed", usage: {}, finishReason: "completed" } as GatewayEvent;
      return;
    }

    if (decision.decision === "allow") {
      yield { type: "assistant_text_delta", text: "Action executed successfully." };
      yield {
        type: "tool_call_finished",
        toolCallId: "tc-1",
        ok: true,
        resultPreview: "ok",
        toolName: "dangerous_action",
      };
    } else {
      yield { type: "assistant_text_delta", text: "Permission denied by user." };
    }

    yield { type: "turn_completed", usage: {}, finishReason: "completed" } as GatewayEvent;
  }

  async permissionDecide(input: { requestId: string; decision: "allow" | "deny"; remember?: boolean; reason?: string }): Promise<{ delivered: boolean }> {
    const entry = this.pending.get(input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve({ decision: input.decision, remember: input.remember, reason: input.reason });
    return { delivered: true };
  }

  async abortTurn(): Promise<void> {
    this.aborted = true;
    for (const [, entry] of this.pending) {
      entry.resolve({ decision: "deny", reason: "aborted" });
    }
    this.pending.clear();
  }

  listSessions = stub({ sessions: [] as never[] });
  resumeSession = stub({ sessionKey: "s" });
  newSession = stub({ sessionKey: `new-${Date.now()}` });
  closeSession = noop as Gateway["closeSession"];
  describeServer = stub({ mode: "in_process" as const });
  cronCreate = stub({ taskId: "c", task: {} as any, created: true }) as unknown as Gateway["cronCreate"];
  cronList = stub({ tasks: [] }) as Gateway["cronList"];
  cronDelete = stub({ deleted: true }) as Gateway["cronDelete"];
  cronStop = stub({ stopped: true }) as Gateway["cronStop"];
  cronRunNow = stub({ triggered: true }) as unknown as Gateway["cronRunNow"];
  respondElicitation = stub({ delivered: false }) as Gateway["respondElicitation"];
  grantSessionPermission = stub({ granted: false }) as Gateway["grantSessionPermission"];
  readSessionMessages = stub({ messages: [], hasMore: false, session: {} as any }) as unknown as Gateway["readSessionMessages"];
  listProjects = stub({ projects: [] }) as Gateway["listProjects"];
  describeProject = stub({ projectKey: "", name: "", root: "", fullPath: "", sessionCount: 0 }) as unknown as Gateway["describeProject"];
}

// ──────────────── helpers ────────────────

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function typeString(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch);
    await wait(5);
  }
}

async function waitForFrame(
  instance: ReturnType<typeof render>,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = instance.lastFrame() ?? "";
    if (pattern.test(frame)) return frame;
    await wait(50);
  }
  const last = instance.lastFrame() ?? "(empty)";
  throw new Error(`Timeout (${label}). Pattern: ${pattern}\nLast frame:\n${last}`);
}

async function waitForNoPattern(
  instance: ReturnType<typeof render>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = instance.lastFrame() ?? "";
    if (!pattern.test(frame)) return frame;
    await wait(50);
  }
  return instance.lastFrame() ?? "";
}

type TestResult = { name: string; pass: boolean; detail: string };
const results: TestResult[] = [];

function pass(name: string, detail = "") {
  results.push({ name, pass: true, detail });
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name: string, detail: string) {
  results.push({ name, pass: false, detail });
  process.stderr.write(`  ✗ ${name}: ${detail}\n`);
}

function renderTui() {
  const gw = new MockGateway();
  const cwd = process.cwd();
  const instance = render(
    <TuiApp gateway={gw} connection="in_process" projectKey={cwd} cwd={cwd} model="mock" />,
  );
  return { instance, gw };
}

// ──────────────── Test: y (allow once) ────────────────

async function testAllowOnce(): Promise<void> {
  const name = "y — allow once";
  process.stdout.write(`\n▸ ${name}\n`);

  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "do something dangerous");
    instance.stdin.write("\r");

    const permFrame = await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    if (/dangerous_action/.test(permFrame)) {
      pass(`${name}: prompt shows tool name`);
    } else {
      fail(`${name}: prompt shows tool name`, "tool name not in frame");
    }
    if (/\[y\].*\[a\].*\[n\].*\[Esc\]/.test(permFrame)) {
      pass(`${name}: prompt shows all keybindings`);
    } else {
      fail(`${name}: prompt shows keybindings`, `frame: ${permFrame.slice(-200)}`);
    }

    instance.stdin.write("y");

    const afterFrame = await waitForNoPattern(instance, /Permission required/, 3_000);
    if (!/Permission required/.test(afterFrame)) {
      pass(`${name}: prompt dismissed`);
    } else {
      fail(`${name}: prompt dismissed`, "prompt still visible");
    }
    if (/executed successfully/.test(afterFrame)) {
      pass(`${name}: tool executed`);
    } else {
      fail(`${name}: tool executed`, `frame snippet: ${afterFrame.slice(0, 300)}`);
    }
  } finally {
    instance.unmount();
  }
}

// ──────────────── Test: a (allow + remember) ────────────────

async function testAllowRemember(): Promise<void> {
  const name = "a — allow + remember";
  process.stdout.write(`\n▸ ${name}\n`);

  const originalSettings = readPermissionSettings();
  writePermissionSettings({ allowedTools: [], disallowedTools: [], skipPermissions: false });

  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "do something memorable");
    instance.stdin.write("\r");

    await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    instance.stdin.write("a");

    await waitForNoPattern(instance, /Permission required/, 3_000);

    const updated = readPermissionSettings();
    if (updated.allowedTools.includes("dangerous_action")) {
      pass(`${name}: rule persisted to permissions.json`);
    } else {
      fail(`${name}: rule persisted`, `allowedTools: ${JSON.stringify(updated.allowedTools)}`);
    }
  } finally {
    instance.unmount();
    writePermissionSettings(originalSettings);
  }
}

// ──────────────── Test: n (deny) ────────────────

async function testDeny(): Promise<void> {
  const name = "n — deny";
  process.stdout.write(`\n▸ ${name}\n`);

  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "do something denied");
    instance.stdin.write("\r");

    await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    instance.stdin.write("n");

    const afterFrame = await waitForNoPattern(instance, /Permission required/, 3_000);
    if (!/Permission required/.test(afterFrame)) {
      pass(`${name}: prompt dismissed`);
    } else {
      fail(`${name}: prompt dismissed`, "still visible");
    }
    if (/denied/.test(afterFrame) || !/executed successfully/.test(afterFrame)) {
      pass(`${name}: tool NOT executed`);
    } else {
      fail(`${name}: tool NOT executed`, "tool appears to have run");
    }
  } finally {
    instance.unmount();
  }
}

// ──────────────── Test: Esc (abort) ────────────────

async function testAbort(): Promise<void> {
  const name = "Esc — abort turn";
  process.stdout.write(`\n▸ ${name}\n`);

  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "do something abortable");
    instance.stdin.write("\r");

    await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    instance.stdin.write("\x1B"); // Escape

    const afterFrame = await waitForNoPattern(instance, /Permission required/, 3_000);
    if (!/Permission required/.test(afterFrame)) {
      pass(`${name}: prompt dismissed`);
    } else {
      fail(`${name}: prompt dismissed`, "still visible");
    }
    if (!/executed successfully/.test(afterFrame)) {
      pass(`${name}: turn aborted (no tool output)`);
    } else {
      fail(`${name}: turn aborted`, "tool executed despite abort");
    }
  } finally {
    instance.unmount();
  }
}

// ──────────────── Test: bypass mode skips prompt ────────────────

async function testBypassMode(): Promise<void> {
  const name = "/mode bypassPermissions";
  process.stdout.write(`\n▸ ${name}\n`);

  const originalSettings = readPermissionSettings();

  const { instance } = renderTui();
  try {
    await wait(100);

    await typeString(instance, "/mode bypassPermissions");
    instance.stdin.write("\r");
    await wait(200);

    const modeFrame = instance.lastFrame() ?? "";
    if (/bypassPermissions/.test(modeFrame)) {
      pass(`${name}: mode changed`);
    } else {
      fail(`${name}: mode changed`, `frame: ${modeFrame.slice(0, 200)}`);
    }

    const updated = readPermissionSettings();
    if (updated.skipPermissions === true) {
      pass(`${name}: skipPermissions persisted`);
    } else {
      fail(`${name}: skipPermissions persisted`, `got: ${JSON.stringify(updated)}`);
    }
  } finally {
    instance.unmount();
    writePermissionSettings(originalSettings);
  }
}

// ──────────────── main ────────────────

async function main(): Promise<void> {
  process.stdout.write("═══════════════════════════════════════════════\n");
  process.stdout.write(" TUI Permission Prompt — E2E Smoke Test\n");
  process.stdout.write(" (mock gateway, no model API needed)\n");
  process.stdout.write("═══════════════════════════════════════════════\n");

  const tests = [testAllowOnce, testAllowRemember, testDeny, testAbort, testBypassMode];

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      fail(test.name, error instanceof Error ? error.message : String(error));
    }
  }

  process.stdout.write("\n═══════════════════════════════════════════════\n");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  process.stdout.write(` Results: ${passed} passed, ${failed} failed (${results.length} total)\n`);
  process.stdout.write("═══════════════════════════════════════════════\n");

  if (failed > 0) {
    process.stdout.write("\nFailed:\n");
    for (const r of results.filter((r) => !r.pass)) {
      process.stdout.write(`  ✗ ${r.name}: ${r.detail}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
