import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { VideoStore } from "../../../src/tool/builtin/videos/VideoStore.js";
import { VideoJobManager, unfinishedVideoJob } from "../../../src/tool/builtin/videos/VideoJobManager.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(64)]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const config = { enabled: true, apiKey: "not-in-ledger", model: "minimax-h3", baseUrl: "https://videos.example/v1" };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "video-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"); await mkdir(cwd);
  const store = new VideoStore(join(root, "generated-videos"));
  const context: PilotDeckToolRuntimeContext = { cwd, sessionId: "session", turnId: "turn", currentToolCallId: "call",
    permissionMode: "default", permissionContext: { cwd, mode: "default", additionalWorkingDirectories: [],
      rules: { allow: [], deny: [], ask: [] }, canPrompt: true, bypassAvailable: true } };
  return { root, store, context };
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for recovery"); await delay(5); }
}

test("persists ID before any GET; transient status and interrupted download retry without POST or DELETE", async t => {
  const { store, context } = await fixture(t); let posts = 0, queries = 0, downloads = 0, deletes = 0;
  const manager: VideoJobManager = new VideoJobManager({ store, getConfig: () => config, pollMs: 1, retryMs: 1, fetchImpl: async (url, init): Promise<Response> => {
    if (init?.method === "DELETE") deletes++;
    if (init?.method === "POST") { posts++; return json({ id: "remote-one", status: "queued" }); }
    const saved = await manager.forCall("session", "call"); assert.equal(saved?.remoteId, "remote-one");
    if (String(url).endsWith("/content")) {
      if (++downloads === 1) return new Response(new ReadableStream({ start(c) { c.enqueue(mp4.subarray(0, 12)); c.error(new Error("connection reset")); } }));
      return new Response(mp4);
    }
    if (++queries === 1) throw new TypeError("fetch failed");
    return json({ id: "remote-one", status: "completed" });
  } });
  const job = await manager.submit(config, { prompt: "secret prompt", purpose: "deliverable" }, context);
  const ledger = await readFile(join(manager.root, (await import("node:crypto")).createHash("sha256").update("session").digest("hex"), job.id + ".json"), "utf8");
  assert.ok(!ledger.includes(config.apiKey)); assert.ok(!ledger.includes("secret prompt"));
  const completed = await manager.wait(job, context);
  assert.equal(completed.state, "completed"); assert.equal(completed.video?.videoId, job.id);
  assert.deepEqual(await readFile(completed.video!.path), mp4);
  assert.equal(posts, 1); assert.equal(deletes, 0); assert.equal(downloads, 2);
  assert.equal((await store.list("session")).length, 1);
});

test("stopping an Agent waiter leaves the accepted task tracking and recoverable", async t => {
  const { store, context } = await fixture(t); let ready = false, posts = 0;
  const manager = new VideoJobManager({ store, getConfig: () => config, pollMs: 2, fetchImpl: async (url, init) => {
    if (init?.method === "POST") { posts++; return json({ id: "remote", status: "queued" }); }
    assert.notEqual(init?.method, "DELETE");
    return String(url).endsWith("/content") ? new Response(mp4) : json({ status: ready ? "completed" : "queued" });
  } });
  const job = await manager.submit(config, { prompt: "ball", purpose: "deliverable" }, context);
  const abort = new AbortController();
  const waiter = manager.wait(job, { ...context, abortSignal: abort.signal });
  abort.abort(); await assert.rejects(waiter);
  ready = true;
  await until(async () => (await manager.get("session", job.id)).state === "completed");
  assert.equal(posts, 1);
});

test("timeout retains ID, disabled tools can recover and manual resume only queries the existing job", async t => {
  const { store, context } = await fixture(t); let ready = false; const methods: string[] = [];
  const options = { store, getConfig: () => ({ ...config, enabled: false }), pollMs: 1, timeoutMs: 15, fetchImpl: (async (url, init) => {
    methods.push(init?.method ?? "GET");
    return String(url).endsWith("/content") ? new Response(mp4) : json({ id: "kept", status: ready ? "completed" : "queued" });
  }) as typeof fetch };
  const manager = new VideoJobManager(options);
  const job = await manager.submit(config, { prompt: "ball", purpose: "deliverable" }, context);
  const paused = await manager.wait(job, context);
  assert.equal(paused.state, "paused"); assert.equal(paused.reason, "timeout"); assert.equal(paused.remoteId, "kept");
  // Allow the previous owner to release the file before a simulated fresh host.
  await delay(5); ready = true;
  const restarted = new VideoJobManager({ ...options, timeoutMs: 5000 });
  await restarted.resume("session", job.id);
  await until(async () => (await restarted.get("session", job.id)).state === "completed");
  assert.equal(methods.filter(m => m === "POST").length, 1); assert.ok(!methods.includes("DELETE"));
  await assert.rejects(() => restarted.resume("other-session", job.id), /ENOENT/);
});

test("changed service address pauses without sending saved credentials; provider failures stay terminal", async t => {
  const { store, context } = await fixture(t); let changed = false, calls = 0;
  const manager = new VideoJobManager({ store, getConfig: () => changed ? { ...config, baseUrl: "https://other.example/v1" } : config,
    pollMs: 1, fetchImpl: async (_url, init) => { calls++; return json({ id: "old-host", status: init?.method === "POST" ? "queued" : "failed" }); } });
  const job = await manager.submit(config, { prompt: "ball", purpose: "intermediate" }, context); changed = true;
  assert.equal((await manager.wait(job, context)).reason, "configuration"); assert.equal(calls, 1);
  await delay(5); changed = false; await manager.resume("session", job.id);
  await until(async () => (await manager.get("session", job.id)).state === "failed");
  assert.equal((await manager.resume("session", job.id)).state, "failed"); assert.equal(calls, 2);
});

test("recovered child videos remain usable by parent and sibling, with project export and display-scope isolation", async t => {
  const { store, context } = await fixture(t);
  const manager = new VideoJobManager({ store, getConfig: () => config, pollMs: 1, fetchImpl: async url => String(url).endsWith("/content") ? new Response(mp4) : json({ id: "child", status: "completed" }) });
  await manager.registerParent("parent", "workspace::sub::child-id");
  const job = await manager.submit(config, { prompt: "ball", purpose: "intermediate", output_path: "assets/movie.mp4" }, { ...context, sessionId: "workspace::sub::child-id" });
  await manager.start(job);
  assert.deepEqual(await readFile(join(context.cwd, "assets/movie.mp4")), mp4);
  assert.equal((await store.get("parent", job.id)).purpose, "intermediate");
  assert.ok((await manager.contextForSession("parent"))?.includes(job.id));
  await store.inheritOnce("parent", job.id, "sibling"); assert.ok(await store.get("sibling", job.id));
  assert.equal((await manager.forCall("parent::sub::child-id", "call"))?.id, job.id);
  assert.equal(await manager.forCall("unrelated::sub::child-id", "call"), undefined);
});

test("a fresh process recovers a killed worker's ID and lease without another submission", async t => {
  const { root, store, context } = await fixture(t); let ready = false, posts = 0, queries = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain form */ }
    if (req.method === "POST") posts++; else queries++;
    res.end(req.url?.endsWith("/content") ? mp4 : JSON.stringify({ id: "restart-id", status: ready ? "completed" : "queued" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`;
  const params = { config: { ...config, baseUrl: url }, context, root: store.root };
  const modulePath = resolve("src/tool/builtin/videos/VideoJobManager.js");
  const storePath = resolve("src/tool/builtin/videos/VideoStore.js");
  const script = join(root, "worker.mjs");
  await writeFile(script, `import {VideoJobManager} from ${JSON.stringify(modulePath)}; import {VideoStore} from ${JSON.stringify(storePath)};
    const p=${JSON.stringify(params)}; const m=new VideoJobManager({store:new VideoStore(p.root),getConfig:()=>p.config,pollMs:5});
    const j=await m.submit(p.config,{prompt:'ball',purpose:'deliverable'},p.context); await m.start(j);`);
  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", c => { errors += c; });
  t.after(() => child.kill("SIGKILL"));
  await until(async () => { if (child.exitCode !== null) throw new Error(errors); return queries > 0; });
  const job = (await new VideoJobManager({ store, getConfig: () => params.config }).forCall("session", "call"))!;
  child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); ready = true;
  const fresh = new VideoJobManager({ store, getConfig: () => params.config, pollMs: 1 });
  const stop = fresh.startRecovery(10); t.after(stop);
  await until(async () => !unfinishedVideoJob(await fresh.get("session", job.id)));
  assert.equal((await fresh.get("session", job.id)).state, "completed"); assert.equal(posts, 1);
  assert.deepEqual(await readFile((await store.get("session", job.id)).path), mp4);
});

test('the next Agent context receives recovered IDs without waking the interrupted turn or another session', async t => {
  const { store, context } = await fixture(t);
  const manager = new VideoJobManager({ store, getConfig: () => config, pollMs: 1, fetchImpl: async url => String(url).endsWith('/content') ? new Response(mp4) : json({ id: 'known', status: 'completed' }) });
  const job = await manager.submit(config, { prompt: 'ball', purpose: 'deliverable' }, context);
  await manager.start(job);
  const { DefaultContextRuntime } = await import('../../../src/context/DefaultContextRuntime.js');
  const runtime = new DefaultContextRuntime({ sessionArtifactContext: id => manager.contextForSession(id) });
  const input = { sessionId: 'session', turnId: 'next', cwd: context.cwd, permissionMode: 'default' as const, additionalWorkingDirectories: [], provider: 'test', model: 'test', tools: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Save the previous video' }] }] };
  const recovered = await runtime.prepareForModel(input);
  const status = recovered.messages.find(m => m.metadata?.purpose === 'session_artifact_status');
  assert.ok(JSON.stringify(status).includes(job.id)); assert.ok(!JSON.stringify(status).includes(config.apiKey));
  assert.equal((await runtime.prepareForModel({ ...input, sessionId: 'unrelated' })).messages.some(m => m.metadata?.purpose === 'session_artifact_status'), false);
});

test('video streaming may outlast the short status-request timeout and uses the original attachment identity', async t => {
  const { store, context } = await fixture(t);
  const manager = new VideoJobManager({ store, getConfig: () => config, requestTimeoutMs: 10, timeoutMs: 5000,
    fetchImpl: async url => String(url).endsWith('/content') ? new Response(new ReadableStream({ async start(c) { await delay(30); c.enqueue(mp4); c.close(); } })) : json({ id: 'slow', status: 'completed' }) });
  const job = await manager.submit(config, { prompt: 'ball', purpose: 'deliverable' }, context);
  await manager.start(job);
  assert.equal((await manager.get('session', job.id)).video?.videoId, job.id);
});
test('a lost submission response leaves no invented ID or retryable submission', async t => {
  const { store, context } = await fixture(t); let calls = 0;
  const manager = new VideoJobManager({ store, getConfig: () => config, fetchImpl: async () => { calls++; throw new TypeError('connection reset before ID'); } });
  await assert.rejects(() => manager.submit(config, { prompt: 'ball', purpose: 'deliverable' }, context));
  assert.equal(calls, 1); assert.deepEqual(await manager.list('session'), []);
});

test('tool-call replay reuses the accepted ID, while the same provider call ID in another turn creates a new task', async t => {
  const { store, context } = await fixture(t); let posts = 0;
  const manager = new VideoJobManager({ store, getConfig: () => config, fetchImpl: async () => { posts++; return json({ id: 'accepted-' + posts, status: 'queued' }); } });
  const input = { prompt: 'ball', purpose: 'deliverable' as const };
  const first = await manager.submit(config, input, context);
  assert.equal((await manager.submit(config, input, context)).id, first.id);
  const second = await manager.submit(config, input, { ...context, turnId: 'another-turn' });
  assert.notEqual(second.id, first.id); assert.equal(posts, 2);
  assert.equal((await manager.forCall('session', 'call', 'turn'))?.id, first.id);
  assert.equal((await manager.forCall('session', 'call', 'another-turn'))?.id, second.id);
});
