import assert from "node:assert/strict";
import test from "node:test";
import { SopExecutionClient, type SopCall } from "../../src/sop/execution/SopExecutionClient.js";
import { SopExecutionHost } from "../../src/sop/execution/SopExecutionHost.js";

test("host retries a lost submit response without executing the leaf twice", async () => {
  let effects = 0, submits = 0;
  const bodies: unknown[] = [];
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const client = new SopExecutionClient("http://unused", "test");
  client.preflight = async () => {};
  let claimed = false;
  client.request = async <T>(path: string, _scope?: string, body?: unknown): Promise<T> => {
    if (path === "/healthz") return { maxConcurrency: 32 } as T;
    if (path === "/v4/worker/claim") {
      if (claimed) return { calls: [] } as T;
      claimed = true;
      return { calls: [{ id: "call", attempt: 1, lease: { token: "lease" } } as SopCall] } as T;
    }
    bodies.push(body);
    if (++submits === 1) throw new Error("response lost after server commit");
    complete();
    return { accepted: true } as T;
  };
  const host = new SopExecutionHost(client, async () => { effects++; return { status: "completed" }; });
  await host.start();
  await done;
  await host.dispose();
  assert.equal(effects, 1);
  assert.equal(submits, 2);
  assert.deepEqual(bodies[0], bodies[1]);
});

test("host shutdown aborts an active leaf and records unknown outcome without replay", async () => {
  let claimed = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let submitted: Record<string, unknown> | undefined;
  const client = new SopExecutionClient("http://unused", "test");
  client.preflight = async () => {};
  client.request = async <T>(path: string, _scope?: string, body?: unknown): Promise<T> => {
    if (path === "/healthz") return { maxConcurrency: 32 } as T;
    if (path === "/v4/worker/claim") {
      if (claimed) return { calls: [] } as T;
      claimed = true;
      return { calls: [{ id: "call", attempt: 1, lease: { token: "lease" } } as SopCall] } as T;
    }
    submitted = body as Record<string, unknown>;
    return { accepted: true } as T;
  };
  const host = new SopExecutionHost(client, async (_call, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return { status: "completed" };
  });
  await host.start();
  await ready;
  await host.dispose();
  assert.equal(submitted?.status, "result_unknown");
});

test("client rejects unknown execution fields before I/O", async () => {
  const client = new SopExecutionClient("http://unused", "test");
  await assert.rejects(client.call("sop_status", "/project", { runId: "a".repeat(32), contextMode: "inherit" }), /Unknown SOP/);
});
