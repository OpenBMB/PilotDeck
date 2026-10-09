import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelStatePersistence } from "../../../../src/adapters/channel/protocol/ChannelStatePersistence.js";

test("load after save returns the in-memory (not yet flushed) state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-state-"));
  // Seed an old snapshot on disk with a long debounce so the new save cannot
  // have flushed yet.
  const persistence = new ChannelStatePersistence({ stateDir: dir, debounceMs: 60_000 });
  try {
    await persistence.save("ch1", { session: "old" });
    await persistence.flush();
    assert.deepEqual(await persistence.load("ch1"), { session: "old" });

    await persistence.save("ch1", { session: "new" });
    // Immediately after save(new), a load must NOT read the old disk snapshot.
    assert.deepEqual(await persistence.load("ch1"), { session: "new" });
  } finally {
    // Drain the pending 60-second debounce timer so the spec exits cleanly.
    await persistence.flush();
  }
});

test("load waits for an in-flight write instead of reading a stale file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-state-"));
  const persistence = new ChannelStatePersistence({ stateDir: dir, debounceMs: 60_000 });

  await persistence.save("ch1", { v: "first" });
  await persistence.flush();

  // save() is synchronous: it only stages into `dirty`. Kicking a flush
  // without awaiting it drains `dirty` and starts the write (inFlight), so a
  // load issued while the write is active must not fall back to the stale
  // disk snapshot; it should await the in-flight write and observe "second".
  await persistence.save("ch1", { v: "second" });
  const flushing = persistence.flush();
  const loaded = await persistence.load("ch1");
  await flushing;
  assert.equal((loaded as { v: string } | undefined)?.v, "second");
});

test("load returns disk state when nothing is pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-state-"));
  const persistence = new ChannelStatePersistence({ stateDir: dir });
  await writeFile(join(dir, "ch2.state.json"), JSON.stringify({ hello: "disk" }), "utf8");
  assert.deepEqual(await persistence.load("ch2"), { hello: "disk" });
});

test("load returns undefined for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-state-"));
  const persistence = new ChannelStatePersistence({ stateDir: dir });
  assert.equal(await persistence.load("missing"), undefined);
});
