import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";

for (const storage of ["snapshot", "ordinary"] as const) {
  test(`fork retargets ${storage} references and marks inherited messages as fork carryover`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fork-compact-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const chatDir = getPilotProjectChatDir(root, root);
    const sourceId = "source";
    const sourceDir = join(chatDir, sourceId);
    const sourcePath = join(chatDir, `${sourceId}.jsonl`);
    await mkdir(join(sourceDir, "tool-results"), { recursive: true });
    const toolPath = join(sourceDir, "tool-results", "output.txt");
    const mediaPath = join(sourceDir, "tool-results", "image.png");
    await writeFile(toolPath, "tool output");
    await writeFile(mediaPath, "image payload");
    const messages: CanonicalMessage[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "call", name: "read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result_reference", toolCallId: "call", path: toolPath,
          originalBytes: 11, preview: "tool", hasMore: true },
        { type: "media_reference", path: mediaPath, originalBytes: 13,
          preview: "image", hasMore: true, mimeType: "image/png", mediaType: "image" },
      ] },
    ];
    const writer = new JsonlTranscriptWriter({ path: sourcePath });
    await writer.recordAcceptedInput(sourceId, "turn", [{ role: "user", content: [{ type: "text", text: "work" }] }]);
    if (storage === "snapshot") {
      await writer.recordControlBoundary(sourceId, "turn", {
        kind: "compact", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 100 },
        snapshot: { version: 1, messages },
      });
    } else {
      for (const message of messages) await writer.recordDurableMessage(sourceId, "turn", message);
    }
    await writer.recordTurnResult(sourceId, "turn", {
      type: "success", sessionId: sourceId, turnId: "turn", stopReason: "completed",
      usage: {}, permissionDenials: [], turns: 1,
      startedAt: "2026-09-17T00:00:00.000Z", completedAt: "2026-09-17T00:01:00.000Z",
    });
    await writer.recordAcceptedInput(sourceId, "next", [{ role: "user", content: [{ type: "text", text: "next" }] }]);
    const sourceBefore = await readFile(sourcePath, "utf8");
    const fromEntryId = (await readTranscript(sourcePath)).entries.at(-1)!.entryId!;
    const fork = await forkWebSession({ sessionKey: sourceId, fromEntryId }, { projectRoot: root, pilotHome: root });
    const forkDir = join(chatDir, sanitizeSessionIdForPath(fork.newSessionKey));
    const replay = replayTranscriptEntries((await readTranscript(`${forkDir}.jsonl`)).entries);
    for (const message of replay.messages) {
      assert.deepEqual(message.metadata?.forkCarryover, { sourceSessionId: sourceId, sourceTurnId: "turn" });
    }
    assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
    const references = replay.messages.flatMap((message) => message.content).filter(
      (block) => block.type === "tool_result_reference" || block.type === "media_reference",
    );
    assert.deepEqual(references.map((block) => block.path), [
      join(forkDir, "tool-results", "output.txt"), join(forkDir, "tool-results", "image.png"),
    ]);
    // The fork must stay self-contained even after the source's auxiliary files are removed.
    await rm(sourceDir, { recursive: true });
    assert.deepEqual(await Promise.all(references.map((block) => readFile(block.path, "utf8"))), ["tool output", "image payload"]);
  });
}
