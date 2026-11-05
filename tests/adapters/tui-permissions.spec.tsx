import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/adapters/channel/tui/app/TuiApp.js";
import { writePermissionSettings, readPermissionSettings } from "../../src/permission/settings.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

let previousPilotHome: string | undefined;
let testPilotHome: string;
beforeEach(() => {
  previousPilotHome = process.env.PILOT_HOME;
  testPilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-tui-permissions-"));
  process.env.PILOT_HOME = testPilotHome;
  writePermissionSettings({ allowedTools: [], askTools: [], disallowedTools: [], skipPermissions: false });
});
afterEach(() => {
  if (previousPilotHome === undefined) delete process.env.PILOT_HOME;
  else process.env.PILOT_HOME = previousPilotHome;
  rmSync(testPilotHome, { recursive: true, force: true });
});

type PendingPermission = {
  resolve: (d: { decision: "allow" | "deny"; remember?: boolean; reason?: string }) => void;
};

const noop = async () => {};
const stub = <T,>(v: T) => async () => v;

class MockGateway implements Gateway {
  async steerTurn(): Promise<{ accepted: boolean; reason?: "no_active_turn" }> {
    return { accepted: false, reason: "no_active_turn" };
  }
  async cancelSteer(): Promise<{ cancelled: boolean; reason?: "no_active_turn" }> {
    return { cancelled: false, reason: "no_active_turn" };
  }
  private pending = new Map<string, PendingPermission>();
  aborted = false;

  async replaceLastTurn(): Promise<never> {
    throw new Error("replaceLastTurn is not used by this TUI test.");
  }

  async finalizeLastTurnReplacement(): Promise<never> {
    throw new Error("finalizeLastTurnReplacement is not used by this TUI test.");
  }

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
  cronUpdate = stub({ updated: false, reason: "not_found" }) as Gateway["cronUpdate"];
  cronDelete = stub({ deleted: true }) as Gateway["cronDelete"];
  cronStop = stub({ stopped: true }) as Gateway["cronStop"];
  cronRunNow = stub({ triggered: true }) as unknown as Gateway["cronRunNow"];
  respondElicitation = stub({ delivered: false }) as Gateway["respondElicitation"];
  grantSessionPermission = stub({ granted: false }) as Gateway["grantSessionPermission"];
  readSessionMessages = stub({ messages: [], hasMore: false, session: {} as any }) as unknown as Gateway["readSessionMessages"];
  readSubagentMessages = stub({ messages: [], total: 0 }) as unknown as Gateway["readSubagentMessages"];
  forkSession = stub({ newSessionKey: "web:s_fork", prefillText: "", carriedMessageCount: 0 }) as unknown as Gateway["forkSession"];
  listProjects = stub({ projects: [] }) as Gateway["listProjects"];
  describeProject = stub({ projectKey: "", name: "", root: "", fullPath: "", sessionCount: 0 }) as unknown as Gateway["describeProject"];
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function typeString(instance: ReturnType<typeof render>, text: string): Promise<void> {
  instance.stdin.write(text);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (instance.lastFrame()?.includes(text)) return;
    await wait(20);
  }
  assert.fail("The prompt did not receive the test input.");
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

function renderTui() {
  const gw = new MockGateway();
  const cwd = process.cwd();
  const instance = render(
    <TuiApp gateway={gw} connection="in_process" projectKey={cwd} cwd={cwd} model="mock" />,
  );
  return { instance, gw };
}

test("TUI allow-once approves the action without persisting a rule", async () => {
  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "request approval");
    instance.stdin.write("\r");
    const prompt = await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    assert.match(prompt, /dangerous_action/);
    assert.match(prompt, /\[y\].*\[a\].*\[n\].*\[Esc\]/);
    instance.stdin.write("y");
    const completed = await waitForFrame(instance, /executed successfully/, 3_000, "approved action");
    assert.doesNotMatch(completed, /Permission required/);
    assert.deepEqual(readPermissionSettings().allowedTools, []);
  } finally { instance.unmount(); }
});

test("TUI allow-and-remember persists the tool permission", async () => {
  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "remember approval");
    instance.stdin.write("\r");
    await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    instance.stdin.write("a");
    await waitForFrame(instance, /executed successfully/, 3_000, "remembered action");
    assert.ok(readPermissionSettings().allowedTools.includes("dangerous_action"));
  } finally { instance.unmount(); }
});

test("TUI deny dismisses the prompt without executing the action", async () => {
  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "deny action");
    instance.stdin.write("\r");
    await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    instance.stdin.write("n");
    const denied = await waitForFrame(instance, /Permission denied by user/, 3_000, "denied action");
    assert.doesNotMatch(denied, /Permission required|executed successfully/);
  } finally { instance.unmount(); }
});

test("TUI Escape aborts the pending action", async () => {
  const { instance, gw } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "abort action");
    instance.stdin.write("\r");
    await waitForFrame(instance, /Permission required/, 5_000, "permission prompt");
    instance.stdin.write("\x1B");
    const aborted = await waitForNoPattern(instance, /Permission required/, 3_000);
    assert.equal(gw.aborted, true);
    assert.doesNotMatch(aborted, /Permission required|executed successfully/);
  } finally { instance.unmount(); }
});

test("TUI permission mode changes persist in the isolated profile", async () => {
  const { instance } = renderTui();
  try {
    await wait(100);
    await typeString(instance, "/mode bypassPermissions");
    instance.stdin.write("\r");
    await waitForFrame(instance, /Mode: bypassPermissions/, 3_000, "permission mode");
    assert.equal(readPermissionSettings().skipPermissions, true);
  } finally { instance.unmount(); }
});
