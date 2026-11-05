import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CanonicalMessage } from "../../src/model/index.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { toCanonicalToolResultBlock } from "../../src/tool/protocol/result.js";
import { createVideoGenerationTools } from "../../src/tool/builtin/videoGeneration.js";
import { VideoStore, type GeneratedVideo } from "../../src/tool/builtin/videos/VideoStore.js";
import { VideoJobManager } from "../../src/tool/builtin/videos/VideoJobManager.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";
import { readSubagentWebMessages, readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

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
  let time = Date.now();
  const now = () => new Date(time = Math.max(time + 1, Date.now()));
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

const recoveryConfig = { enabled: true, apiKey: 'fixture-key', model: 'fixture-video', baseUrl: 'https://videos.example/v1' };
function recoveryContext(f: Awaited<ReturnType<typeof fixture>>, sessionId = f.sourceId, turnId = 'draw', currentToolCallId = 'recovered-call'): PilotDeckToolRuntimeContext {
  return { sessionId, turnId, currentToolCallId, cwd: f.projectRoot, permissionMode: 'default',
    permissionContext: { mode: 'default', cwd: f.projectRoot, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] }, canPrompt: false, bypassAvailable: false } };
}
function interruptedMessages(call = 'recovered-call'): CanonicalMessage[] {
  return [{ role: 'assistant', content: [{ type: 'tool_call', id: call, name: 'generate_video', input: { prompt: 'ball', purpose: 'deliverable' } }] },
    { role: 'user', content: [toCanonicalToolResultBlock({ type: 'error', toolName: 'generate_video', toolCallId: call,
      error: { code: 'tool_aborted', message: 'Waiting stopped.' }, content: [{ type: 'text', text: 'Waiting stopped.' }], startedAt: '', completedAt: '' })] }];
}
function recoveryManager(f: Awaited<ReturnType<typeof fixture>>) {
  return new VideoJobManager({ store: f.store, getConfig: () => recoveryConfig,
    fetchImpl: async url => String(url).endsWith('/content') ? new Response(new Uint8Array(f.mp4)) : new Response(JSON.stringify({ id: 'remote', status: 'completed' })) });
}
for (const shape of ['error', 'missing-result', 'compact', 'restore'] as const) {
  test(`fork inherits recovered ${shape} video by retained invocation, including its ledger and original ID`, async t => {
    const f = await fixture(t); const manager = recoveryManager(f);
    const messages = interruptedMessages();
    await f.writer.recordAcceptedInput(f.sourceId, 'draw', [{ role: 'user', content: [{ type: 'text', text: 'generate' }] }]);
    await f.writer.recordDurableMessage(f.sourceId, 'draw', messages[0]);
    const job = await manager.submit(recoveryConfig, { prompt: 'ball', purpose: 'deliverable' }, recoveryContext(f));
    if (shape !== 'missing-result') await f.writer.recordDurableMessage(f.sourceId, 'draw', messages[1]);
    await manager.start(job);
    if (shape === 'compact') await f.writer.recordControlBoundary(f.sourceId, 'snapshot-turn', {
      kind: 'compact', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 100 }, snapshot: { version: 1, messages },
    });
    if (shape === 'restore') await f.writer.recordControlBoundary(f.sourceId, 'snapshot-turn', {
      kind: 'restore', operationId: 'restore', visibleSequences: [1, 2, 3], snapshot: { version: 1, messages },
    });
    await f.finish(); const fromEntryId = await f.forkPoint();
    const cutoff = Date.parse((await readTranscript(f.transcriptPath)).entries.at(-1)!.createdAt);
    while (Date.now() <= cutoff) await delay(1);
    // A later task, even with a reused provider call ID, is outside the fork.
    const future = await manager.submit(recoveryConfig, { prompt: 'later', purpose: 'deliverable' }, recoveryContext(f, f.sourceId, 'next', 'recovered-call'));
    await manager.start(future);
    const before = await readFile(f.transcriptPath, 'utf8');
    const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
    const inherited = await f.store.get(fork.newSessionKey, job.id);
    const inheritedJob = await manager.forCall(fork.newSessionKey, 'recovered-call', 'draw');
    assert.equal(inheritedJob?.state, 'completed'); assert.equal(inheritedJob?.video?.sessionId, fork.newSessionKey);
    assert.equal(inheritedJob?.remoteId, job.remoteId);
    assert.ok((await manager.contextForSession(fork.newSessionKey))?.includes(job.id));
    assert.ok(!(await manager.contextForSession(fork.newSessionKey))?.includes(future.id));
    await assert.rejects(() => f.store.get(fork.newSessionKey, future.id), /ENOENT/);
    assert.equal(await manager.forCall(fork.newSessionKey, 'recovered-call', 'next'), undefined);
    assert.equal(await readFile(f.transcriptPath, 'utf8'), before);
    if (shape !== 'missing-result') {
      const history = await readWebSessionMessages({ sessionKey: fork.newSessionKey }, f.options);
      const result = history.messages.find(m => m.kind === 'tool_result' && m.toolCallId === 'recovered-call')!;
      assert.equal(result.ok, true);
      assert.equal((result.payload as any).videoGeneration.sessionId, fork.newSessionKey);
    }
    const forkPath = join(f.chatDir, sanitizeSessionIdForPath(fork.newSessionKey) + '.jsonl');
    const nestedPoint = (await readTranscript(forkPath)).entries.find(e => e.type === 'assistant_message')!;
    const nested = await forkWebSession({ sessionKey: fork.newSessionKey, fromEntryId: nestedPoint.entryId! }, f.options);
    const original = await f.store.get(f.sourceId, job.id);
    await rm(dirname(original.path), { recursive: true });
    const save = createVideoGenerationTools({ store: f.store, getConfig: () => recoveryConfig })[1]!;
    await save.execute({ video_id: job.id, output_path: 'recovered.mp4' }, recoveryContext(f, fork.newSessionKey));
    assert.deepEqual(await readFile(join(f.projectRoot, 'recovered.mp4')), f.mp4);
    await rm(dirname(inherited.path), { recursive: true });
    assert.deepEqual(await readFile((await f.store.get(nested.newSessionKey, job.id)).path), f.mp4);
    assert.equal((await manager.forCall(nested.newSessionKey, 'recovered-call', 'draw'))?.state, 'completed');
  });
}

test('fork retains recovered child jobs with no tool result and resolves their copied detail scope', async t => {
  const f = await fixture(t); const manager = recoveryManager(f);
  const childId = 'child'; const childSession = f.projectRoot + '::sub::child';
  await manager.registerParent(f.sourceId, childSession);
  await f.writer.recordAcceptedInput(f.sourceId, 'draw', [{ role: 'user', content: [{ type: 'text', text: 'delegate' }] }]);
  await f.writer.recordSubagentStarted(f.sourceId, 'draw', { subagentId: childId, subagentType: 'general-purpose', prompt: 'draw',
    transcriptRelativePath: f.writer.relativeSubagentPath(childId), subagentSessionId: childSession });
  const child = f.writer.forSubagent(childId, f.now);
  await child.writer.recordDurableMessage(childSession, 'child-turn', interruptedMessages()[0]);
  const job = await manager.submit(recoveryConfig, { prompt: 'ball', purpose: 'deliverable' }, recoveryContext(f, childSession, 'child-turn'));
  await manager.start(job);
  await f.writer.recordDurableMessage(f.sourceId, 'draw', { role: 'assistant', content: [{ type: 'text', text: 'Child wait was interrupted.' }] });
  await f.finish(); const fromEntryId = await f.forkPoint();
  const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
  const resolved = await manager.forCall(fork.newSessionKey + '::sub::child', 'recovered-call');
  assert.equal(resolved?.state, 'completed'); assert.equal(resolved?.video?.sessionId, fork.newSessionKey);
  assert.equal(await manager.forCall('unrelated::sub::child', 'recovered-call'), undefined);
  await rm(dirname((await f.store.get(childSession, job.id)).path), { recursive: true });
  assert.deepEqual(await readFile((await f.store.get(fork.newSessionKey, job.id)).path), f.mp4);
});

for (const boundary of ['compact', 'restore'] as const) {
  test(`fork keeps parent and sibling videos isolated when recovered ${boundary} snapshots reuse a call ID`, async t => {
    const f = await fixture(t);
    let remote = 0;
    const manager = new VideoJobManager({ store: f.store, getConfig: () => recoveryConfig,
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') return Response.json({ id: `remote-${++remote}`, status: 'queued' });
        if (String(url).endsWith('/content')) return new Response(Buffer.concat([f.mp4, Buffer.from(String(url))]));
        return Response.json({ status: 'completed' });
      } });
    const call = 'call_0';
    const messages = interruptedMessages(call);
    await f.writer.recordAcceptedInput(f.sourceId, 'draw', [{ role: 'user', content: [{ type: 'text', text: 'delegate videos' }] }]);
    await f.writer.recordDurableMessage(f.sourceId, 'draw', messages[0]);
    const parentJob = await manager.submit(recoveryConfig, { prompt: 'blue', purpose: 'deliverable' }, recoveryContext(f, f.sourceId, 'draw', call));
    await manager.start(parentJob);
    const parentVideo = (await manager.get(f.sourceId, parentJob.id)).video!;
    const parentResult: CanonicalMessage = { role: 'user', content: [toCanonicalToolResultBlock({ type: 'success', toolName: 'generate_video', toolCallId: call,
      content: [{ type: 'text', text: 'blue video' }], data: { videoGeneration: parentVideo }, startedAt: '', completedAt: '' })] };
    await f.writer.recordDurableMessage(f.sourceId, 'draw', parentResult);
    const writeSnapshot = (writer: JsonlTranscriptWriter, sessionId: string, snapshotMessages: CanonicalMessage[]) =>
      writer.recordControlBoundary(sessionId, 'snapshot-turn', boundary === 'compact'
        ? { kind: 'compact', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 100 }, snapshot: { version: 1, messages: snapshotMessages } }
        : { kind: 'restore', operationId: 'restore', visibleSequences: [1, 2], snapshot: { version: 1, messages: snapshotMessages } });
    const children = [];
    for (const childId of ['child', 'sibling']) {
      const sessionId = f.projectRoot + '::sub::' + childId;
      await manager.registerParent(f.sourceId, sessionId);
      await f.writer.recordSubagentStarted(f.sourceId, 'draw', { subagentId: childId, subagentType: 'general-purpose', prompt: 'red video',
        transcriptRelativePath: f.writer.relativeSubagentPath(childId), subagentSessionId: sessionId });
      const child = f.writer.forSubagent(childId, f.now);
      for (const message of messages) await child.writer.recordDurableMessage(sessionId, 'child-turn', message);
      const job = await manager.submit(recoveryConfig, { prompt: childId, purpose: 'deliverable' }, recoveryContext(f, sessionId, 'child-turn', call));
      await manager.start(job);
      await writeSnapshot(child.writer, sessionId, messages);
      children.push({ childId, job, video: (await manager.get(sessionId, job.id)).video! });
    }
    await writeSnapshot(f.writer, f.sourceId, [messages[0], parentResult]);
    await f.finish();
    const fromEntryId = await f.forkPoint();
    const original = await readFile(f.transcriptPath, 'utf8');
    let fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
    for (let generation = 0; generation < 2; generation++) {
      const forkPath = join(f.chatDir, sanitizeSessionIdForPath(fork.newSessionKey) + '.jsonl');
      const entries = (await readTranscript(forkPath)).entries;
      const jobs = await manager.list(fork.newSessionKey);
      assert.equal(jobs.length, 3);
      assert.equal(jobs.find(job => job.id === parentJob.id)?.forkSubagentId, undefined);
      assert.equal((await manager.forCall(fork.newSessionKey, call))?.id, parentJob.id);
      const parentResults = replayTranscriptEntries(entries).messages.flatMap(message => message.content).filter(block => block.type === 'tool_result');
      assert.deepEqual(parentResults.map(block => (block.raw as { data: { videoGeneration: GeneratedVideo } }).data.videoGeneration.videoId), [parentJob.id]);
      for (const { childId, job, video } of children) {
        assert.equal(jobs.find(item => item.id === job.id)?.forkSubagentId, childId);
        const resolved = await manager.forCall(fork.newSessionKey + '::sub::' + childId, call);
        assert.equal(resolved?.id, job.id);
        assert.equal(resolved?.video?.sessionId, fork.newSessionKey);
        const marker = entries.find(entry => entry.type === 'subagent_started' && entry.subagentId === childId)!;
        assert.equal(marker.type, 'subagent_started');
        const childEntries = (await readTranscript(join(f.chatDir, marker.transcriptRelativePath))).entries;
        const results = replayTranscriptEntries(childEntries).messages.flatMap(message => message.content).filter(block => block.type === 'tool_result');
        assert.equal(results.length, 1);
        const recovered = (results[0].raw as { data: { videoGeneration: GeneratedVideo } }).data.videoGeneration;
        assert.equal(recovered.videoId, job.id);
        assert.equal(recovered.sessionId, fork.newSessionKey);
        assert.deepEqual(await readFile(recovered.path), await readFile(video.path));
        const history = await readSubagentWebMessages({ sessionKey: fork.newSessionKey, subagentId: childId }, f.options);
        const row = history.messages.find(message => message.kind === 'tool_result' && message.toolCallId === call)!;
        assert.equal(row.ok, true);
        assert.equal((row.payload as { videoGeneration: GeneratedVideo }).videoGeneration.videoId, job.id);
      }
      if (generation === 0) {
        const writer = new JsonlTranscriptWriter({ path: forkPath, now: f.now });
        writer.restoreState(Math.max(...entries.map(entry => entry.sequence)), entries.at(-1)!.entryId!);
        await writer.recordAcceptedInput(fork.newSessionKey, 'next-fork', [{ role: 'user', content: [{ type: 'text', text: 'fork again' }] }]);
        const point = (await readTranscript(forkPath)).entries.at(-1)!.entryId!;
        fork = await forkWebSession({ sessionKey: fork.newSessionKey, fromEntryId: point }, f.options);
      }
    }
    assert.equal(await readFile(f.transcriptPath, 'utf8'), original);
  });
}

test('a child snapshot without a matching job never borrows a parent video with the same call ID', async t => {
  const f = await fixture(t); const manager = recoveryManager(f);
  const call = 'call_0', childId = 'child', sessionId = f.projectRoot + '::sub::child';
  await f.writer.recordAcceptedInput(f.sourceId, 'draw', [{ role: 'user', content: [{ type: 'text', text: 'delegate' }] }]);
  await f.writer.recordDurableMessage(f.sourceId, 'draw', interruptedMessages(call)[0]);
  const parentJob = await manager.submit(recoveryConfig, { prompt: 'blue', purpose: 'deliverable' }, recoveryContext(f, f.sourceId, 'draw', call));
  await manager.start(parentJob);
  await f.writer.recordSubagentStarted(f.sourceId, 'draw', { subagentId: childId, subagentType: 'general-purpose', prompt: 'red video',
    transcriptRelativePath: f.writer.relativeSubagentPath(childId), subagentSessionId: sessionId });
  const child = f.writer.forSubagent(childId, f.now);
  for (const message of interruptedMessages(call)) await child.writer.recordDurableMessage(sessionId, 'child-turn', message);
  await child.writer.recordControlBoundary(sessionId, 'snapshot-turn', { kind: 'compact', subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 100 }, snapshot: { version: 1, messages: interruptedMessages(call) } });
  await f.finish(); const fromEntryId = await f.forkPoint();
  const fork = await forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options);
  const history = await readSubagentWebMessages({ sessionKey: fork.newSessionKey, subagentId: childId }, f.options);
  const result = history.messages.find(message => message.kind === 'tool_result')!;
  assert.equal(result.ok, false);
  assert.equal((result.payload as { videoGeneration?: GeneratedVideo })?.videoGeneration, undefined);
  assert.equal(await manager.forCall(fork.newSessionKey + '::sub::' + childId, call), undefined);
  assert.equal((await manager.forCall(fork.newSessionKey, call))?.id, parentJob.id);
  assert.equal((await manager.list(fork.newSessionKey))[0].forkSubagentId, undefined);
});

test('failed fork rolls back recovered job records as well as copied attachments', async t => {
  const f = await fixture(t); const manager = recoveryManager(f);
  await f.writer.recordAcceptedInput(f.sourceId, 'draw', [{ role: 'user', content: [{ type: 'text', text: 'generate' }] }]);
  for (const message of interruptedMessages()) await f.writer.recordDurableMessage(f.sourceId, 'draw', message);
  const job = await manager.submit(recoveryConfig, { prompt: 'ball', purpose: 'deliverable' }, recoveryContext(f));
  await manager.start(job);
  const missing = await f.store.save(f.sourceId, new Response(new Uint8Array(f.mp4)));
  await f.writer.recordDurableMessage(f.sourceId, 'draw', videoMessage(missing));
  await unlink(join(dirname(missing.path), missing.videoId + '.json'));
  await f.finish(); const fromEntryId = await f.forkPoint();
  await assert.rejects(() => forkWebSession({ sessionKey: f.sourceId, fromEntryId }, f.options), /Could not inherit session attachments/);
  for (const directory of await readdir(manager.root)) for (const name of await readdir(join(manager.root, directory))) {
    if (name.endsWith('.json')) assert.equal(JSON.parse(await readFile(join(manager.root, directory, name), 'utf8')).sessionId, f.sourceId);
  }
  assert.deepEqual((await readdir(f.chatDir)).filter(name => name.endsWith('.jsonl')), [sanitizeSessionIdForPath(f.sourceId) + '.jsonl']);
});
