import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReviewPacket } from "../../../../src/agent/sub/delivery/packet.js";
import { countTokens } from "../../../../src/context/budget/tokenizer.js";

const BUDGET = 4000;

async function tmpWorkspace(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pd-delivery-packet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("buildReviewPacket includes task and schema, and returns estimated tokenCount", async (t) => {
  const cwd = await tmpWorkspace(t);
  const packet = await buildReviewPacket({
    task: "Write the frobnicator module.",
    schema: { type: "object", properties: { summary: { type: "string" } } },
    value: { summary: "did the thing" },
    cwd,
    maxInputTokens: BUDGET,
  });

  assert.match(packet.text, /frobnicator/);
  assert.match(packet.text, /summary/);
  assert.equal(packet.hasContent, true);
  assert.equal(packet.complete, true);
  assert.ok(packet.tokenCount > 0);
  assert.equal(packet.tokenCount, countTokens(packet.text)); // explicit estimate of the exact returned text
  assert.ok(packet.tokenCount <= BUDGET);
});

test("buildReviewPacket includes result text claim (rawText or summary)", async (t) => {
  const cwd = await tmpWorkspace(t);
  const fromValue = await buildReviewPacket({
    task: "t",
    value: { summary: "PLAIN-SUMMARY-MARKER" },
    cwd,
    maxInputTokens: BUDGET,
  });
  assert.match(fromValue.text, /PLAIN-SUMMARY-MARKER/);

  const fromRaw = await buildReviewPacket({
    task: "t",
    rawText: "RAW-CLAIM-MARKER all done",
    cwd,
    maxInputTokens: BUDGET,
  });
  assert.match(fromRaw.text, /RAW-CLAIM-MARKER/);
  assert.equal(fromRaw.complete, true);
});

test("buildReviewPacket hasContent:false for empty delivery", async (t) => {
  const cwd = await tmpWorkspace(t);
  const empty = await buildReviewPacket({ task: "t", value: {}, rawText: "  ", cwd, maxInputTokens: BUDGET });
  assert.equal(empty.hasContent, false);
  assert.equal(empty.complete, false);
  assert.ok(empty.warnings.length > 0);
});

test("buildReviewPacket excludes inputs/sources/intermediates file contents (sentinel)", async (t) => {
  const cwd = await tmpWorkspace(t);
  await mkdir(path.join(cwd, "inputs"), { recursive: true });
  await writeFile(path.join(cwd, "inputs", "source.md"), "SENTINEL-SECRET-SOURCE-CONTENT\nmore\n");
  const packet = await buildReviewPacket({
    task: "t",
    value: {
      inputs: [{ file: "inputs/source.md" }],
      sources: [{ file: "inputs/source.md" }],
      intermediates: [{ file: "inputs/source.md" }],
      summary: "ok",
    },
    cwd,
    maxInputTokens: BUDGET,
  });
  assert.ok(!packet.text.includes("SENTINEL-SECRET-SOURCE-CONTENT"));
  assert.equal(packet.complete, true);
});

test("buildReviewPacket excerpts result.file and only result/final artifacts", async (t) => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "result.md"), "RESULT-FILE-MARKER body\n");
  await writeFile(path.join(cwd, "art-result.md"), "ART-RESULT-MARKER\n");
  await writeFile(path.join(cwd, "art-final.md"), "ART-FINAL-MARKER\n");
  await writeFile(path.join(cwd, "art-source.md"), "ART-SOURCE-SENTINEL\n");

  const packet = await buildReviewPacket({
    task: "t",
    value: {
      result: { file: "result.md", summary: "ship it" },
      artifacts: [
        { role: "result", file: "art-result.md" },
        { role: "final", file: "art-final.md" },
        { role: "source", file: "art-source.md" },
        { role: "intermediate", file: "art-source.md" },
      ],
    },
    cwd,
    maxInputTokens: BUDGET,
  });

  assert.match(packet.text, /RESULT-FILE-MARKER/);
  assert.match(packet.text, /ART-RESULT-MARKER/);
  assert.match(packet.text, /ART-FINAL-MARKER/);
  assert.ok(!packet.text.includes("ART-SOURCE-SENTINEL"));
  assert.equal(packet.complete, true);
});

test("buildReviewPacket includes supplied changed-file line excerpts only", async (t) => {
  const cwd = await tmpWorkspace(t);
  const lines = Array.from({ length: 50 }, (_, i) => `LINE-${String(i + 1).padStart(2, "0")}`);
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "a.txt"), lines.join("\n"));

  const packet = await buildReviewPacket({
    task: "t",
    value: {
      changes: [{ file: "src/a.txt", description: "tweak", locations: [{ startLine: 2, endLine: 3 }] }],
    },
    cwd,
    maxInputTokens: BUDGET,
  });

  assert.match(packet.text, /LINE-02/);
  assert.match(packet.text, /LINE-03/);
  assert.ok(!packet.text.includes("LINE-07"), "only the supplied line window may be included");
  assert.equal(packet.complete, true);
});

test("buildReviewPacket selects at most 8 files and warns when more exist", async (t) => {
  const cwd = await tmpWorkspace(t);
  const artifacts = [];
  for (let i = 0; i < 10; i++) {
    await writeFile(path.join(cwd, `piece-${i}.txt`), `PIECE-${i}-MARKER\n`);
    artifacts.push({ role: "result", file: `piece-${i}.txt` });
  }
  const packet = await buildReviewPacket({
    task: "t",
    value: { artifacts },
    cwd,
    maxInputTokens: 20000,
  });

  const included = packet.text.match(/PIECE-\d+-MARKER/g) ?? [];
  assert.ok(included.length <= 8, `expected <= 8 excerpts, got ${included.length}`);
  assert.ok(packet.warnings.some((w) => /8|file|limit/i.test(w)));
  assert.equal(packet.complete, false);
});

test("buildReviewPacket: binary result evidence is flagged, complete:false", async (t) => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "movie.mp4"), Buffer.from([0x00, 0x01, 0x00, 0x02]));
  const packet = await buildReviewPacket({
    task: "t",
    value: { result: { file: "movie.mp4" } },
    cwd,
    maxInputTokens: BUDGET,
  });
  assert.ok(packet.warnings.some((w) => /binary/i.test(w)));
  assert.equal(packet.complete, false);
  assert.equal(packet.hasContent, true);
});

test("buildReviewPacket: missing result evidence is flagged, complete:false", async (t) => {
  const cwd = await tmpWorkspace(t);
  const packet = await buildReviewPacket({
    task: "t",
    value: { result: { file: "vanishing.md" } },
    cwd,
    maxInputTokens: BUDGET,
  });
  assert.ok(packet.warnings.some((w) => /missing|not found|exist/i.test(w)));
  assert.equal(packet.complete, false);
});

test("buildReviewPacket: oversized content is truncated with a visible marker", async (t) => {
  const cwd = await tmpWorkspace(t);
  const packet = await buildReviewPacket({
    task: "t".repeat(60000),
    value: { summary: "s".repeat(60000) },
    cwd,
    maxInputTokens: 3000,
  });
  assert.match(packet.text, /\[truncated\]/i);
  assert.equal(packet.complete, false);
  assert.ok(packet.tokenCount <= 3000);
});

test("buildReviewPacket: task+schema alone exceeding budget omit result content", async (t) => {
  const cwd = await tmpWorkspace(t);
  const packet = await buildReviewPacket({
    task: "task-with-a-very-long-description ".repeat(200),
    schema: { type: "object", properties: { a: { type: "string", description: "x".repeat(2000) } } },
    value: { summary: "SHOULD-NOT-APPEAR-MARKER" },
    cwd,
    maxInputTokens: 120,
  });
  assert.equal(packet.complete, false);
  assert.ok(packet.warnings.some((w) => /budget|task|schema/i.test(w)));
  assert.ok(!packet.text.includes("SHOULD-NOT-APPEAR-MARKER"));
  assert.ok(packet.tokenCount <= 120);
});

test("buildReviewPacket: aborts via signal", async (t) => {
  const cwd = await tmpWorkspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    buildReviewPacket({ task: "t", value: {}, cwd, maxInputTokens: BUDGET, signal: controller.signal }),
  );
});

test("buildReviewPacket: outside-workspace evidence is not read", async (t) => {
  const cwd = await tmpWorkspace(t);
  const outside = await mkdtemp(path.join(tmpdir(), "pd-delivery-packet-out-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "leak.txt"), "OUTSIDE-LEAK-MARKER");
  const packet = await buildReviewPacket({
    task: "t",
    value: { result: { file: path.join(outside, "leak.txt") } },
    cwd,
    maxInputTokens: BUDGET,
  });
  assert.ok(!packet.text.includes("OUTSIDE-LEAK-MARKER"));
  assert.equal(packet.complete, false);
});

test('never calls a clipped claim or oversized task complete', async t => {
  const cwd = await tmpWorkspace(t);
  for (const options of [
    { task: 'x'.repeat(5000), value: { result: { text: 'done' } } },
    { task: 'report', value: { result: { text: 'y'.repeat(13000) } } },
  ]) {
    const packet = await buildReviewPacket({ ...options, cwd, maxInputTokens: 16000 });
    assert.equal(packet.complete, false);
  }
});

test('nested custom role result is read; a clipped file is inconclusive', async t => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, 'report.md'), 'TRUSTED FILE TEXT');
  const complete = await buildReviewPacket({ task: 'report', value: { custom: { output: { role: 'result', file: 'report.md' } } }, cwd, maxInputTokens: 4000 });
  assert.match(complete.text, /TRUSTED FILE TEXT/);
  await writeFile(path.join(cwd, 'report.md'), 'x'.repeat(20000));
  const clipped = await buildReviewPacket({ task: 'report', value: { result: { file: 'report.md' } }, cwd, maxInputTokens: 4000 });
  assert.equal(clipped.complete, false);
});
