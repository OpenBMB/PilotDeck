import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

test("transcript writer commits compaction boundary and replacement surface as one event", async () => {
  const writer = new InMemoryTranscriptWriter({ uuid: () => "entry-1" });
  await writer.recordCompactionReplacement!(
    "session-atomic-writer",
    "turn-1",
    {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 20 },
    },
    [{ role: "assistant", content: [{ type: "text", text: "summary" }] }],
  );

  assert.equal(writer.entries.length, 1);
  const entry = writer.entries[0];
  assert.equal(entry?.type, "control_boundary");
  if (entry?.type !== "control_boundary") return;
  assert.equal(entry.boundary.kind, "compact");
  if (entry.boundary.kind !== "compact" || entry.boundary.subtype !== "compact_boundary") return;
  assert.deepEqual(entry.boundary.snapshot, { version: 1, messages: [
    { role: "assistant", content: [{ type: "text", text: "summary" }] },
  ] });
});
