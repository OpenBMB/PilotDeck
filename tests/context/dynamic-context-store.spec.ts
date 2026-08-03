import test from "node:test";
import assert from "node:assert/strict";
import { DynamicContextStore } from "../../src/context/dynamic/DynamicContextStore.js";

test("merges pending context by priority and consumes it once", () => {
  const store = new DynamicContextStore();
  store.register({ sessionId: "session-1", source: "monitor", id: "status", content: "monitor status" });
  store.register({
    sessionId: "session-1",
    source: "rules",
    id: "src/app",
    content: "rules for src/app",
    priority: "critical",
  });

  const pending = store.getPending("session-1");
  assert.deepEqual(pending.entries.map((entry) => entry.source), ["rules", "monitor"]);
  assert.equal(pending.merged, "rules for src/app\n\n---\n\nmonitor status");
  assert.equal(store.consume("session-1").merged, pending.merged);
  assert.equal(store.hasPending("session-1"), false);
});

test("re-registering the same source and id replaces stale content without changing order", () => {
  const store = new DynamicContextStore();
  store.register({ sessionId: "session-1", source: "rules", id: "src/app", content: "old" });
  store.register({ sessionId: "session-1", source: "memory", id: "current", content: "memory" });
  store.register({ sessionId: "session-1", source: "rules", id: "src/app", content: "new" });

  const pending = store.getPending("session-1");
  assert.deepEqual(pending.entries.map((entry) => entry.content), ["new", "memory"]);
});

test("expired context is pruned without affecting another session", () => {
  const store = new DynamicContextStore();
  store.register({ sessionId: "session-1", source: "goal", id: "current", content: "expired", expiresAt: 100 });
  store.register({ sessionId: "session-2", source: "goal", id: "current", content: "active", expiresAt: 200 });

  assert.equal(store.hasPending("session-1", 101), false);
  assert.equal(store.getPending("session-2", 101).merged, "active");
});

test("blank context is ignored", () => {
  const store = new DynamicContextStore();
  store.register({ sessionId: "session-1", source: "hook", id: "blank", content: "  \n " });
  assert.equal(store.hasPending("session-1"), false);
});

test("clearing a session does not disturb another session with a shared prefix", () => {
  const store = new DynamicContextStore();
  store.register({ sessionId: "case", source: "hook", id: "one", content: "first" });
  store.register({ sessionId: "case:child", source: "hook", id: "two", content: "second" });

  store.clear("case");

  assert.equal(store.hasPending("case"), false);
  assert.equal(store.getPending("case:child").merged, "second");
});

test("context budgets retain higher-priority entries and cap merged prompt size", () => {
  const store = new DynamicContextStore();
  for (let index = 0; index < 70; index += 1) {
    store.register({ sessionId: "session-1", source: "bulk", id: String(index), content: `low-${index}`, priority: "low" });
  }
  store.register({ sessionId: "session-1", source: "goal", id: "critical", content: "critical checkpoint", priority: "critical" });
  store.register({ sessionId: "session-2", source: "large", id: "one", content: "x".repeat(100_000) });
  store.register({ sessionId: "session-2", source: "large", id: "two", content: "y".repeat(100_000) });

  const boundedEntries = store.getPending("session-1").entries;
  assert.equal(boundedEntries.length, 64);
  assert.equal(boundedEntries[0]?.content, "critical checkpoint");
  assert.ok(store.getPending("session-2").merged.length <= 65_536);
  assert.ok(store.getPending("session-2").entries.every((entry) => entry.content.length <= 16_384));
});

test("source and id tuples cannot collide through delimiter characters", () => {
  const store = new DynamicContextStore();
  store.register({ sessionId: "session-1", source: "plugin:a", id: "b", content: "first" });
  store.register({ sessionId: "session-1", source: "plugin", id: "a:b", content: "second" });

  assert.deepEqual(store.getPending("session-1").entries.map((entry) => entry.content), ["first", "second"]);
});
