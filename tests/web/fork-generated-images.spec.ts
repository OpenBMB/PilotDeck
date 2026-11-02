import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import type { CanonicalMessage } from "../../src/model/index.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { toCanonicalToolResultBlock } from "../../src/tool/protocol/result.js";
import { createImageGenerationTools } from "../../src/tool/builtin/imageGeneration.js";
import { ImageStore, type GeneratedImage } from "../../src/tool/builtin/images/ImageStore.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

function imageMessage(image: GeneratedImage): CanonicalMessage {
  return { role: "user", content: [toCanonicalToolResultBlock({ type: "success", toolName: "generate_image", toolCallId: image.imageId,
    content: [{ type: "text", text: "Attached at " + image.path }], data: { imageGeneration: image }, startedAt: "", completedAt: "" })] };
}
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "fork-images-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectRoot = join(home, "project"); await mkdir(projectRoot);
  const sourceId = "web:source";
  const chatDir = getPilotProjectChatDir(projectRoot, home);
  const transcriptPath = join(chatDir, sanitizeSessionIdForPath(sourceId) + ".jsonl");
  let time = Date.parse("2026-11-02T00:00:00Z");
  const now = () => new Date(time++);
  const writer = new JsonlTranscriptWriter({ path: transcriptPath, now });
  const store = new ImageStore(join(home, "generated-images"));
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "red" } }).png().toBuffer();
  const options = { projectRoot, pilotHome: home, now };
  const finish = () => writer.recordTurnResult(sourceId, "draw", { type: "success", sessionId: sourceId, turnId: "draw", stopReason: "completed",
    usage: {}, permissionDenials: [], turns: 1, startedAt: now().toISOString(), completedAt: now().toISOString() });
  const forkPoint = async () => {
    await writer.recordAcceptedInput(sourceId, "next", [{ role: "user", content: [{ type: "text", text: "continue" }] }]);
    return (await readTranscript(transcriptPath)).entries.at(-1)!.entryId!;
  };
  return { home, projectRoot, sourceId, chatDir, transcriptPath, now, writer, store, png, options, finish, forkPoint };
}

for (const storage of ["ordinary", "snapshot", "restore"] as const) {
  test(`fork inherits ${storage} images for preview, editing and saving without depending on the parent`, async t => {
    const f = await fixture(t);
    const first = await f.store.save(f.sourceId, f.png);
    const message = imageMessage(first);
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
    const future = await f.store.save(f.sourceId, f.png);
    await f.writer.recordDurableMessage(f.sourceId, "next", imageMessage(future));
    const original = await readFile(f.transcriptPath, "utf8");
    const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
    const inherited = await f.store.get(fork.newSessionKey, first.imageId);
    assert.equal(inherited.imageId, first.imageId);
    assert.equal(inherited.sessionId, fork.newSessionKey);
    assert.notEqual(inherited.path, first.path);
    assert.deepEqual(await readFile(inherited.path), f.png);
    await assert.rejects(() => f.store.get(fork.newSessionKey, future.imageId), /ENOENT/);
    await assert.rejects(() => f.store.inherit(f.sourceId, first.imageId, fork.newSessionKey), /EEXIST/);
    assert.deepEqual(await readFile(inherited.path), f.png, "a duplicate copy never removes an existing image");
    assert.equal(await readFile(f.transcriptPath, "utf8"), original);
    const history = await readWebSessionMessages({ sessionKey: fork.newSessionKey }, f.options);
    const row = history.messages.find(item => item.kind === "tool_result" && item.toolCallId === first.imageId)!;
    assert.equal((row.payload as { imageGeneration: GeneratedImage }).imageGeneration.sessionId, fork.newSessionKey);
    assert.ok(row.text?.includes(inherited.path));
    assert.ok(!row.text?.includes(first.path));

    let requests = 0;
    const tools = createImageGenerationTools({ store: f.store, getConfig: () => ({ enabled: true, apiKey: "key", model: "image" }),
      fetchImpl: async (url, init) => {
        requests++;
        assert.ok(String(url).endsWith("/images/edits"));
        const image = (init!.body as unknown as import("undici").FormData).get("image") as File;
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), f.png);
        return new Response(JSON.stringify({ data: [{ b64_json: f.png.toString("base64") }] }));
      },
    });
    const context: PilotDeckToolRuntimeContext = { sessionId: fork.newSessionKey, turnId: "edit", cwd: f.projectRoot,
      permissionMode: "default", env: { PILOT_HOME: f.home },
      permissionContext: { mode: "default", cwd: f.projectRoot, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] }, canPrompt: false, bypassAvailable: false } };
    await tools[2]!.execute({ image_id: first.imageId, output_path: "saved.png" }, context);
    assert.deepEqual(await readFile(join(f.projectRoot, "saved.png")), f.png);
    assert.equal(requests, 0);
    await tools[1]!.execute({ image_ids: [first.imageId], prompt: "blue", purpose: "deliverable" }, context);
    assert.equal(requests, 1);
    const forkPath = join(f.chatDir, sanitizeSessionIdForPath(fork.newSessionKey) + ".jsonl");
    const entries = (await readTranscript(forkPath)).entries;
    for (const entry of entries) if (entry.type === "control_boundary" && "snapshot" in entry.boundary) {
      const block = entry.boundary.snapshot!.messages[0]!.content[0]!;
      assert.ok(block.type === "tool_result");
      assert.equal((block.raw as { data: { imageGeneration: GeneratedImage } }).data.imageGeneration.sessionId, fork.newSessionKey);
    }
    const point = entries.find(entry => entry.type === "assistant_message")!;
    const nested = await forkWebSession({ sessionKey: fork.newSessionKey, fromEntryId: point.entryId! }, f.options);
    await rm(dirname(first.path), { recursive: true });
    assert.deepEqual(await readFile((await f.store.get(fork.newSessionKey, first.imageId)).path), f.png);
    await rm(dirname(inherited.path), { recursive: true });
    assert.deepEqual(await readFile((await f.store.get(nested.newSessionKey, first.imageId)).path), f.png);
  });
}

test("fork rebinds retained child image history and excludes child output after the fork point", async t => {
  const f = await fixture(t);
  const childId = "child"; const childSession = f.projectRoot + "::sub::child";
  await f.writer.recordAcceptedInput(f.sourceId, "draw", [{ role: "user", content: [{ type: "text", text: "delegate drawing" }] }]);
  await f.writer.recordSubagentStarted(f.sourceId, "draw", { subagentId: childId, subagentType: "general-purpose", prompt: "draw",
    transcriptRelativePath: f.writer.relativeSubagentPath(childId), subagentSessionId: childSession });
  const child = f.writer.forSubagent(childId, f.now);
  const image = await f.store.save(childSession, f.png);
  await child.writer.recordDurableMessage(childSession, "child-turn", imageMessage(image));
  await f.finish();
  const fromEntryId = await f.forkPoint();
  const future = await f.store.save(childSession, f.png);
  await child.writer.recordDurableMessage(childSession, "child-turn", imageMessage(future));
  const original = await readFile(child.transcriptPath, "utf8");
  const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
  assert.deepEqual(await readFile((await f.store.get(fork.newSessionKey, image.imageId)).path), f.png);
  await assert.rejects(() => f.store.get(fork.newSessionKey, future.imageId));
  const parent = await readTranscript(join(f.chatDir, sanitizeSessionIdForPath(fork.newSessionKey) + ".jsonl"));
  const marker = parent.entries.find(entry => entry.type === "subagent_started")!;
  const copied = await readFile(join(f.chatDir, marker.transcriptRelativePath), "utf8");
  assert.ok(copied.includes(fork.newSessionKey));
  assert.ok(!copied.includes(future.imageId));
  assert.equal(await readFile(child.transcriptPath, "utf8"), original);
});

test("a missing inherited image aborts the fork without publishing a broken transcript or partial image copies", async t => {
  const f = await fixture(t);
  await f.writer.recordAcceptedInput(f.sourceId, "draw", [{ role: "user", content: [{ type: "text", text: "draw" }] }]);
  const first = await f.store.save(f.sourceId, f.png);
  const missing = await f.store.save(f.sourceId, f.png);
  for (const image of [first, missing]) await f.writer.recordDurableMessage(f.sourceId, "draw", imageMessage(image));
  await unlink(join(dirname(missing.path), missing.imageId + ".json"));
  await f.finish();
  const fromEntryId = await f.forkPoint();
  await assert.rejects(() => forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options), /Could not inherit session images/);
  assert.deepEqual((await readdir(f.chatDir)).filter(name => name.endsWith(".jsonl")), [sanitizeSessionIdForPath(f.sourceId) + ".jsonl"]);
  for (const dir of await readdir(f.store.root)) {
    if (join(f.store.root, dir) !== dirname(first.path)) assert.deepEqual(await readdir(join(f.store.root, dir)), []);
  }
});
