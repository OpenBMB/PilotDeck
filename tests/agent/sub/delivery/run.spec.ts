import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentLoopRunResult } from "../../../../src/agent/loop/AgentLoop.js";
import { deliveryConfig } from "../../../../src/agent/sub/delivery/config.js";
import { runDelivery } from "../../../../src/agent/sub/delivery/run.js";
import type { DeliveryRunOptions } from "../../../../src/agent/sub/delivery/run.js";
import type { CanonicalMessage } from "../../../../src/model/index.js";

async function tmpWorkspace(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pd-delivery-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function assistantMessage(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

type ScriptStep = { text?: string; structuredOutput?: unknown; turns?: number };

function fakeExecute(script: ScriptStep[], onAttempt?: (attempt: number) => Promise<void>) {
  const calls: Array<{ messages: CanonicalMessage[]; maxTurns: number; attempt: number }> = [];
  const execute = async (messages: CanonicalMessage[], maxTurns: number, attempt: number): Promise<AgentLoopRunResult> => {
    calls.push({ messages, maxTurns, attempt });
    await onAttempt?.(attempt);
    const step = script[Math.min(attempt - 1, script.length - 1)]!;
    const text = step.text ?? JSON.stringify(step.structuredOutput ?? {});
    return {
      result: {
        type: "success",
        sessionId: "child-session",
        turnId: `turn-${attempt}`,
        stopReason: "completed",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        permissionDenials: [],
        turns: step.turns ?? 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ...(step.structuredOutput !== undefined ? { structuredOutput: step.structuredOutput } : {}),
      },
      messages: [assistantMessage(text)],
    };
  };
  return { calls, execute };
}

function baseOptions(cwd: string, overrides: Partial<DeliveryRunOptions> & Pick<DeliveryRunOptions, "execute">): DeliveryRunOptions {
  return {
    cwd,
    subagentId: "run-child",
    task: "Deliver the thing.",
    config: deliveryConfig({ maxRepairs: 1, maxTurns: 4 }),
    contract: {},
    initialMessages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    mainModel: { provider: "main", model: "main-model" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 1: an unclosed ```json fence must not bypass the deterministic checks.
// ---------------------------------------------------------------------------

test("Unclosed json fence wrapping a result runs file checks and repairs the missing file", async (t) => {
  const cwd = await tmpWorkspace(t);
  const { calls, execute } = fakeExecute(
    [
      { text: '```json\n{"result":{"file":"out/answer.md"}}' }, // fence never closed
      { text: '{"result":{"file":"out/answer.md"}}' },
    ],
    async (attempt) => {
      if (attempt === 2) {
        await mkdir(path.join(cwd, "out"), { recursive: true });
        await writeFile(path.join(cwd, "out", "answer.md"), "done");
      }
    },
  );
  const result = await runDelivery(baseOptions(cwd, { execute }));

  assert.equal(calls.length, 2, "a repair round-trip must happen");
  assert.equal(result.delivery.repairs, 1);
  assert.equal(result.delivery.status, "passed");

  // Previously this delivery was treated as prose/skipped; the file check ran.
  const first = JSON.parse(await readFile(result.delivery.attempts[0]!.deliveryFile, "utf8")) as Record<string, any>;
  assert.equal(first.checks.status, "failed");
  assert.equal(first.checks.issues[0].code, "file_missing");
  assert.equal(first.checks.issues[0].path, "result.file");
  assert.deepEqual(first.content, { result: { file: "out/answer.md" } });

  assert.equal(result.delivery.attempts[1]!.checks.status, "passed");
  assert.equal(result.delivery.producerUsage.totalTokens, 30); // usage accounting unchanged
});

// ---------------------------------------------------------------------------
// Fix 2a: raw > 1 MiB persists a bounded failure receipt and stays repairable.
// ---------------------------------------------------------------------------

test("Oversized raw delivery persists a bounded failure receipt and allows repair", async (t) => {
  const cwd = await tmpWorkspace(t);
  const oversized = `{"summary":"${"x".repeat(1024 * 1024)}"}`;
  const { execute } = fakeExecute(
    [{ text: oversized }, { text: '{"result":{"file":"out/answer.md"}}' }],
    async (attempt) => {
      if (attempt === 2) {
        await mkdir(path.join(cwd, "out"), { recursive: true });
        await writeFile(path.join(cwd, "out", "answer.md"), "done");
      }
    },
  );
  const result = await runDelivery(baseOptions(cwd, { execute }));

  assert.equal(result.delivery.status, "passed");
  assert.equal(result.delivery.repairs, 1);
  const firstFile = result.delivery.attempts[0]!.deliveryFile;
  const first = JSON.parse(await readFile(firstFile, "utf8")) as Record<string, any>;

  // Explicit failed status with the parse issue (never a silent pass).
  assert.equal(first.checks.status, "failed");
  assert.equal(first.checks.issues[0].code, "delivery_too_large");
  assert.match(first.checks.issues[0].message, /1048576-byte limit \(\d+ bytes\)/);
  assert.equal(first.content, null);

  // The full raw text was replaced by a bounded receipt.
  const receipt = first.raw_text;
  assert.equal(receipt.omitted, true);
  assert.equal(receipt.byte_count, Buffer.byteLength(oversized, "utf8"));
  assert.equal(receipt.sha256, createHash("sha256").update(oversized).digest("hex"));
  assert.ok(receipt.preview.startsWith('{"summary":"xxx'), receipt.preview.slice(0, 40));
  assert.ok(receipt.preview.length <= 513);

  // The archive itself stayed under the storage cap, without private bulk.
  assert.ok((await stat(firstFile)).size < 1024 * 1024);
  const stored = await readFile(firstFile, "utf8");
  assert.ok(!stored.includes("x".repeat(1000)), "the oversized payload must not be persisted");
});

// ---------------------------------------------------------------------------
// Fix 2b: dense structured output that fits raw can still overflow the pretty
// archive record; it must become an explicit failed receipt, never a pass.
// ---------------------------------------------------------------------------

test("Dense structured output overflowing the pretty archive becomes an explicit failed receipt", async (t) => {
  const cwd = await tmpWorkspace(t);
  const chunks = Array.from({ length: 3400 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(296)}`);
  const structured = { summary: "dense", chunks };
  const { execute, calls } = fakeExecute([{ structuredOutput: structured }]);
  const result = await runDelivery(baseOptions(cwd, { execute, config: deliveryConfig({ maxRepairs: 0, maxTurns: 4 }) }));

  assert.equal(calls.length, 1);
  assert.equal(result.delivery.status, "failed"); // never silently truncated into passed/reviewed
  const stored = JSON.parse(await readFile(result.delivery.deliveryFile, "utf8")) as Record<string, any>;
  assert.equal(stored.checks.status, "failed");
  assert.ok(stored.checks.issues.some((issue: any) => issue.code === "record_too_large"));

  const receipt = stored.content;
  assert.equal(receipt.omitted, true);
  assert.equal(receipt.byte_count, Buffer.byteLength(JSON.stringify(structured), "utf8"));
  assert.equal(receipt.sha256, createHash("sha256").update(JSON.stringify(structured)).digest("hex"));
  assert.ok((await stat(result.delivery.deliveryFile)).size <= 1024 * 1024);
  const storedText = await readFile(result.delivery.deliveryFile, "utf8");
  assert.ok(!storedText.includes(chunks[chunks.length - 1]!), "the omitted payload must not be persisted");
});

// ---------------------------------------------------------------------------
// Fix 4: a requested review with an exhausted shared turn budget is
// inconclusive (turn_limit), not an execution error and not a pass.
// ---------------------------------------------------------------------------

test("Requested review without remaining turns is inconclusive with turn_limit", async (t) => {
  const cwd = await tmpWorkspace(t);
  let reviews = 0;
  const reviewer = async () => {
    reviews += 1;
    throw new Error("reviewer must not run");
  };
  const { execute } = fakeExecute([{ text: '{"summary":"done"}', turns: 4 }]); // producer used the whole budget
  const result = await runDelivery(baseOptions(cwd, {
    contract: { review: true, schema: { type: "object", properties: { summary: { type: "string" } } } },
    reviewer,
    execute,
    config: deliveryConfig({ maxRepairs: 0, maxTurns: 4 }),
  }));

  assert.equal(reviews, 0);
  assert.notEqual(result.delivery.status, "error");
  assert.notEqual(result.delivery.status, "passed");
  assert.equal(result.delivery.status, "inconclusive");

  const review = result.delivery.attempts[0]!.review!;
  assert.equal(review.status, "inconclusive");
  assert.equal(review.issues[0]!.code, "turn_limit");

  const stored = JSON.parse(await readFile(result.delivery.deliveryFile, "utf8")) as Record<string, any>;
  assert.equal(stored.checks.status, "passed"); // the delivery itself was valid
  assert.equal(stored.review.status, "inconclusive");
  assert.equal(result.delivery.producerUsage.totalTokens, 15); // usage accounting unchanged
});


test("Oversized reviewer metadata cannot leave a passed parent result with a failed archive", async (t) => {
  const cwd=await tmpWorkspace(t);
  const {execute}=fakeExecute([{text:'{"result":{"text":"done"}}'}]);
  const result=await runDelivery(baseOptions(cwd, {execute,contract:{review:true},config:deliveryConfig({maxRepairs:0}),
    reviewer:async()=>({status:'accepted',summary:'x'.repeat(1024*1024),issues:[],durationMs:1})}));
  const record=JSON.parse(await readFile(result.delivery.deliveryFile,'utf8'));
  assert.equal(result.delivery.status,'failed');
  assert.equal(record.checks.status,'failed');
  assert.deepEqual(result.delivery.attempts[0]!.checks,record.checks);
  assert.ok((await stat(result.delivery.deliveryFile)).size<1024*1024);
});
