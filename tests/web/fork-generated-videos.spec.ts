import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { toCanonicalToolResultBlock } from "../../src/tool/protocol/result.js";
import { createVideoGenerationTools } from "../../src/tool/builtin/videoGeneration.js";
import { VideoStore, type GeneratedVideo } from "../../src/tool/builtin/videos/VideoStore.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

function videoMessage(video: GeneratedVideo): CanonicalMessage {
  return { role: "user", content: [toCanonicalToolResultBlock({ type: "success", toolName: "generate_video", toolCallId: video.videoId,
    content: [{ type: "text", text: "Attached at " + video.path }], data: { videoGeneration: video }, startedAt: "", completedAt: "" })] };
}
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "fork-videos-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectRoot = join(home, "project"); await mkdir(projectRoot);
  const sourceId = "web:source";
  const chatDir = getPilotProjectChatDir(projectRoot, home);
  const transcriptPath = join(chatDir, sanitizeSessionIdForPath(sourceId) + ".jsonl");
  let time = Date.parse("2026-11-02T00:00:00Z");
  const now = () => new Date(time++);
  const writer = new JsonlTranscriptWriter({ path: transcriptPath, now });
  const store = new VideoStore(join(home, "generated-videos"));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
  const options = { projectRoot, pilotHome: home, now };
  const finish = () => writer.recordTurnResult(sourceId, "draw", { type: "success", sessionId: sourceId, turnId: "draw", stopReason: "completed",
    usage: {}, permissionDenials: [], turns: 1, startedAt: now().toISOString(), completedAt: now().toISOString() });
  const forkPoint = async () => {
    await writer.recordAcceptedInput(sourceId, "next", [{ role: "user", content: [{ type: "text", text: "continue" }] }]);
    return (await readTranscript(transcriptPath)).entries.at(-1)!.entryId!;
  };
  return { home, projectRoot, sourceId, chatDir, transcriptPath, now, writer, store, mp4, options, finish, forkPoint };
}

for (const storage of ["ordinary", "snapshot", "restore"] as const) {
  test(`fork inherits ${storage} videos for preview and saving without depending on the parent`, async t => {
    const f = await fixture(t);
    const first = await f.store.save(f.sourceId, new Response(new Uint8Array(f.mp4)));
    const message = videoMessage(first);
    await f.writer.recordAcceptedInput(f.sourceId, "draw", [{ role: "user", content: [{ type: "text", text: "draw" }] }]);
    await f.writer.recordDurableMessage(f.sourceId, "draw", message);
    if (storage === "snapshot") await f.writer.recordControlBoundary(f.sourceId, "draw", {
      kind: "compact", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 100 }, snapshot: { version: 1, messages: [message] },
    });
    else if (storage === "restore") await f.writer.recordControlBoundary(f.sourceId, "draw", {
      kind: "restore", operationId: "restore", visibleSequences: [1, 2], snapshot: { version: 1, messages: [message] },
    });
    await f.writer.recordDurableMessage(f.sourceId, "draw", { role: "assistant", content: [{ type: "text", text: "Original complete" }] });
    await f.finish();
    const fromEntryId = await f.forkPoint();
    const future = await f.store.save(f.sourceId, new Response(new Uint8Array(f.mp4)));
    await f.writer.recordDurableMessage(f.sourceId, "next", videoMessage(future));
    const original = await readFile(f.transcriptPath, "utf8");
    const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
    const inherited = await f.store.get(fork.newSessionKey, first.videoId);
    assert.equal(inherited.videoId, first.videoId);
    assert.equal(inherited.sessionId, fork.newSessionKey);
    assert.notEqual(inherited.path, first.path);
    assert.deepEqual(await readFile(inherited.path), f.mp4);
    await assert.rejects(() => f.store.get(fork.newSessionKey, future.videoId), /ENOENT/);
    await assert.rejects(() => f.store.inherit(f.sourceId, first.videoId, fork.newSessionKey), /EEXIST/);
    assert.deepEqual(await readFile(inherited.path), f.mp4, "a duplicate copy never removes an existing video");
    assert.equal(await readFile(f.transcriptPath, "utf8"), original);
    const history = await readWebSessionMessages({ sessionKey: fork.newSessionKey }, f.options);
    const row = history.messages.find(item => item.kind === "tool_result" && item.toolCallId === first.videoId)!;
    assert.equal((row.payload as { videoGeneration: GeneratedVideo }).videoGeneration.sessionId, fork.newSessionKey);
    assert.ok(row.text?.includes(inherited.path));
    assert.ok(!row.text?.includes(first.path));

    const tools = createVideoGenerationTools({ store: f.store, getConfig: () => ({ enabled: true, apiKey: "key", model: "video" }),
      fetchImpl: async () => { throw new Error("Saving an existing video must not generate another video."); },
    });
    const context: PilotDeckToolRuntimeContext = { sessionId: fork.newSessionKey, turnId: "save", cwd: f.projectRoot,
      permissionMode: "default", env: { PILOT_HOME: f.home },
      permissionContext: { mode: "default", cwd: f.projectRoot, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] }, canPrompt: false, bypassAvailable: false } };
    await tools[1]!.execute({ video_id: first.videoId, output_path: "saved.mp4" }, context);
    assert.deepEqual(await readFile(join(f.projectRoot, "saved.mp4")), f.mp4);
    const forkPath = join(f.chatDir, sanitizeSessionIdForPath(fork.newSessionKey) + ".jsonl");
    const entries = (await readTranscript(forkPath)).entries;
    for (const entry of entries) if (entry.type === "control_boundary" && "snapshot" in entry.boundary) {
      const block = entry.boundary.snapshot!.messages[0]!.content[0]!;
      assert.ok(block.type === "tool_result");
      assert.equal((block.raw as { data: { videoGeneration: GeneratedVideo } }).data.videoGeneration.sessionId, fork.newSessionKey);
    }
    const point = entries.find(entry => entry.type === "assistant_message")!;
    const nested = await forkWebSession({ sessionKey: fork.newSessionKey, fromEntryId: point.entryId! }, f.options);
    await rm(dirname(first.path), { recursive: true });
    assert.deepEqual(await readFile((await f.store.get(fork.newSessionKey, first.videoId)).path), f.mp4);
    await rm(dirname(inherited.path), { recursive: true });
    assert.deepEqual(await readFile((await f.store.get(nested.newSessionKey, first.videoId)).path), f.mp4);
  });
}

test("fork rebinds retained child video history and excludes child output after the fork point", async t => {
  const f = await fixture(t);
  const childId = "child"; const childSession = f.projectRoot + "::sub::child";
  await f.writer.recordAcceptedInput(f.sourceId, "draw", [{ role: "user", content: [{ type: "text", text: "delegate drawing" }] }]);
  await f.writer.recordSubagentStarted(f.sourceId, "draw", { subagentId: childId, subagentType: "general-purpose", prompt: "draw",
    transcriptRelativePath: f.writer.relativeSubagentPath(childId), subagentSessionId: childSession });
  const child = f.writer.forSubagent(childId, f.now);
  const video = await f.store.save(childSession, new Response(new Uint8Array(f.mp4)));
  await child.writer.recordDurableMessage(childSession, "child-turn", videoMessage(video));
  await f.finish();
  const fromEntryId = await f.forkPoint();
  const future = await f.store.save(childSession, new Response(new Uint8Array(f.mp4)));
  await child.writer.recordDurableMessage(childSession, "child-turn", videoMessage(future));
  const original = await readFile(child.transcriptPath, "utf8");
  const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
  assert.deepEqual(await readFile((await f.store.get(fork.newSessionKey, video.videoId)).path), f.mp4);
  await assert.rejects(() => f.store.get(fork.newSessionKey, future.videoId));
  const parent = await readTranscript(join(f.chatDir, sanitizeSessionIdForPath(fork.newSessionKey) + ".jsonl"));
  const marker = parent.entries.find(entry => entry.type === "subagent_started")!;
  const copied = await readFile(join(f.chatDir, marker.transcriptRelativePath), "utf8");
  assert.ok(copied.includes(fork.newSessionKey));
  assert.ok(!copied.includes(future.videoId));
  assert.equal(await readFile(child.transcriptPath, "utf8"), original);
});

test("a missing inherited video aborts the fork without publishing a broken transcript or partial video copies", async t => {
  const f = await fixture(t);
  await f.writer.recordAcceptedInput(f.sourceId, "draw", [{ role: "user", content: [{ type: "text", text: "draw" }] }]);
  const first = await f.store.save(f.sourceId, new Response(new Uint8Array(f.mp4)));
  const missing = await f.store.save(f.sourceId, new Response(new Uint8Array(f.mp4)));
  for (const video of [first, missing]) await f.writer.recordDurableMessage(f.sourceId, "draw", videoMessage(video));
  await unlink(join(dirname(missing.path), missing.videoId + ".json"));
  await f.finish();
  const fromEntryId = await f.forkPoint();
  await assert.rejects(() => forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options), /Could not inherit session attachments/);
  assert.deepEqual((await readdir(f.chatDir)).filter(name => name.endsWith(".jsonl")), [sanitizeSessionIdForPath(f.sourceId) + ".jsonl"]);
  for (const dir of await readdir(f.store.root)) {
    if (join(f.store.root, dir) !== dirname(first.path)) assert.deepEqual(await readdir(join(f.store.root, dir)), []);
  }
});
