import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { materializeMediaReferences } from "../../../src/model/request/materializeMediaReferences.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

function messages(paths: string[]): CanonicalMessage[] {
  return [{ role: "user", content: paths.map(path => ({ type: "media_reference", mediaType: "image",
    path, mimeType: "image/png", originalBytes: 9, preview: "synthetic", hasMore: false })) }];
}

test("media preparation bounds reads, deduplicates paths and preserves message order", async t => {
  const paths: string[] = [];
  const release: Array<() => void> = [];
  const read = t.mock.method(fs, "readFile", ((path: string) => {
    paths.push(path);
    return new Promise<string>(resolve => { release.push(() => resolve(`data-${path}`)); });
  }) as never);
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
  const input = messages(["a", "b", "c", "d", "a", "e", "f"]);
  const before = structuredClone(input);
  const pending = materializeMediaReferences(input);
  await tick();
  assert.deepEqual(paths, ["a", "b", "c", "d"]);
  release.splice(0).forEach(done => done());
  await tick();
  assert.deepEqual(paths, ["a", "b", "c", "d", "e", "f"]);
  release.splice(0).forEach(done => done());
  const result = await pending;
  assert.deepEqual(result.messages[0].content.map(block => block.type === "image" ? block.data : null),
    ["data-a", "data-b", "data-c", "data-d", "data-a", "data-e", "data-f"]);
  assert.deepEqual(input, before);
});

test("aborting media preparation rejects without starting queued reads or emitting missing-media fallbacks", async t => {
  const abort = new AbortController();
  let calls = 0;
  const read = t.mock.method(fs, "readFile", ((_path: string, options: { signal: AbortSignal }) => {
    calls++;
    return new Promise<string>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  }) as never);
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
  const pending = materializeMediaReferences(messages(["a", "b", "c"]), { signal: abort.signal, maxConcurrency: 1 });
  await tick();
  const reason = new Error("synthetic stop");
  abort.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 1);
  await assert.rejects(materializeMediaReferences(messages(["d"]), { signal: abort.signal }), error => error === reason);
  assert.equal(calls, 1);
});

test("invalid media concurrency rejects before reading", async () => {
  for (const maxConcurrency of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(materializeMediaReferences([], { maxConcurrency }), RangeError);
  }
});
