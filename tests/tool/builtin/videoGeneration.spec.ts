import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VideoStore, type GeneratedVideo } from "../../../src/tool/builtin/videos/VideoStore.js";
import { requestOpenAIVideo } from "../../../src/tool/builtin/videos/openaiVideos.js";
import { createVideoGenerationTools } from "../../../src/tool/builtin/videoGeneration.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { createSubagentVideoInheritance, createSubagentVideoPreparation } from "../../../src/cli/subagentVideoInheritance.js";
import { mapAgentEvent } from "../../../src/gateway/client/InProcessGateway.js";
import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const config = { enabled: true, apiKey: "video-secret", model: "minimax-h3", baseUrl: "https://videos.example/v1" };
const context = (cwd: string, sessionId = "parent"): PilotDeckToolRuntimeContext => ({ sessionId, cwd, turnId: "turn", permissionMode: "default",
  permissionContext: { mode: "default", cwd, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] }, canPrompt: true, bypassAvailable: true } });
const body = () => new Response(new Uint8Array(mp4), { headers: { "content-type": "video/mp4" } });
const json = (v: unknown) => new Response(JSON.stringify(v));
const upstream = async (url: string | URL | Request) => String(url).endsWith("/content") ? body() : json({ id: "video-one", status: "completed" });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "video-tools-")); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"); await mkdir(cwd);
  const store = new VideoStore(join(root, "generated-videos"));
  return { root, cwd, store, tools: createVideoGenerationTools({ store, getConfig: () => config, fetchImpl: upstream }) };
}

test("video create uses real multipart transport, polls once, and streams completed content", async t => {
  const paths: string[] = []; let form: FormData;
  const server = createServer(async (req, res) => {
    paths.push(req.method + " " + req.url);
    if (req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      form = await new Request("http://local", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
    }
    res.setHeader("content-type", req.url?.endsWith("/content") ? "video/mp4" : "application/json");
    res.end(req.url?.endsWith("/content") ? mp4 : JSON.stringify({ id: "one", status: req.method === "POST" ? "queued" : "completed" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await requestOpenAIVideo({ ...config, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }, { prompt: "a ball", seconds: 5, size: "768x512" }, { pollMs: 1 });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4);
  assert.equal(form!.get("model"), "minimax-h3"); assert.equal(form!.get("seconds"), "5"); assert.equal(form!.get("size"), "768x512");
  assert.deepEqual(paths, ["POST /v1/videos", "GET /v1/videos/one", "GET /v1/videos/one/content"]);
});

test("video tools require opt-in and reject stale tool execution after disabling", async () => {
  const diagnostics: any[] = [];
  assert.equal(parseToolsConfig({ videoGeneration: { apiKey: "key", model: "video" } }, diagnostics)?.videoGeneration?.enabled, false);
  assert.deepEqual(diagnostics, []);
  let current = { ...config, enabled: false };
  const options = { store: new VideoStore("/unused"), getConfig: () => current, fetchImpl: async () => { throw new Error("must not fetch"); } };
  assert.equal(createBuiltinRegistry({ videoGeneration: options }).has("generate_video"), false);
  current = { ...current, enabled: true }; const registry = createBuiltinRegistry({ videoGeneration: options });
  assert.ok(registry.has("generate_video")); assert.ok(registry.has("save_generated_video"));
  current.enabled = false;
  for (const tool of createVideoGenerationTools(options)) await assert.rejects(() => tool.execute({}, context("/project")), /disabled/);
});

test("session videos export without regeneration or overwrites; only final generation emits an IM attachment", async t => {
  const { tools, store, cwd } = await fixture(t);
  const output = await tools[0]!.execute({ prompt: "ball", purpose: "deliverable" }, context(cwd));
  const video = (output.data as { videoGeneration: GeneratedVideo }).videoGeneration;
  assert.deepEqual(await readdir(cwd), []); assert.deepEqual(await readFile(video.path), mp4);
  const result = { ...output, type: "success" as const, toolName: "generate_video", toolCallId: "call", startedAt: "", completedAt: "" };
  const mapped = mapAgentEvent({ type: "tool_result", sessionId: "parent", turnId: "turn", result }, "run");
  assert.equal(mapped.filter(e => e.type === "assistant_attachment").length, 1);
  assert.equal((mapped.find(e => e.type === "tool_call_finished") as any).data.videoGeneration.videoId, video.videoId);
  const saved = await tools[1]!.execute({ video_id: video.videoId, output_path: "assets/video.mp4" }, context(cwd));
  assert.deepEqual(await readFile(join(cwd, "assets/video.mp4")), mp4);
  assert.equal(saved.content.some(c => c.type === "file"), false);
  await assert.rejects(() => tools[1]!.execute({ video_id: video.videoId, output_path: "assets/video.mp4" }, context(cwd)), /already exists/);
  await assert.rejects(() => store.get("unrelated-session", video.videoId), /ENOENT/);
  const intermediate = await tools[0]!.execute({ prompt: "ball", purpose: "intermediate" }, context(cwd));
  assert.equal(intermediate.content.some(c => c.type === "file"), false);
});

test("video attachments survive parent to child, child to parent and sibling handoff and source deletion", async t => {
  const { store, cwd } = await fixture(t);
  const parent = await store.save("parent", body());
  const prepare = createSubagentVideoPreparation(store, () => true);
  await prepare({ parentSessionId: "parent", subagentSessionId: "child-a" } as any);
  const child = await store.get("child-a", parent.videoId); assert.notEqual(child.path, parent.path);
  const produced = await store.save("child-a", body(), undefined, "intermediate");
  const inherit = createSubagentVideoInheritance(store);
  const input = { parentSessionId: "parent", subagentSessionId: "child-a", result: { type: "success", toolName: "generate_video", data: { videoGeneration: produced } } } as any;
  await Promise.all([inherit(input), inherit(input)]);
  await prepare({ parentSessionId: "parent", subagentSessionId: "child-b" } as any);
  await unlink(produced.path); await unlink(parent.path);
  const restarted = new VideoStore(store.root);
  const sibling = await restarted.get("child-b", produced.videoId); assert.deepEqual(await readFile(sibling.path), mp4);
  const save = createVideoGenerationTools({ store: restarted, getConfig: () => config })[1]!;
  await save.execute({ video_id: produced.videoId, output_path: "sibling.mp4" }, context(cwd, "child-b"));
  assert.deepEqual(await readFile(join(cwd, "sibling.mp4")), mp4);
  assert.deepEqual(await createSubagentVideoPreparation(restarted, () => false)({ parentSessionId: "parent", subagentSessionId: "disabled" } as any), []);
  await assert.rejects(() => inherit({ ...input, subagentSessionId: "wrong" }), /does not belong/);
});

test("failed MP4 downloads and cancelled streams leave no attachment records", async t => {
  const { store } = await fixture(t);
  await assert.rejects(() => store.save("bad", new Response("not video")), /invalid MP4/);
  assert.deepEqual(await store.list("bad"), []);
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(mp4); abort.abort(); } });
  await assert.rejects(() => store.save("cancelled", new Response(stream), abort.signal));
  assert.deepEqual(await store.list("cancelled"), []);
});

test("video provider errors are redacted and generation POST is never retried", async () => {
  let calls = 0;
  await assert.rejects(() => requestOpenAIVideo(config, { prompt: "ball" }, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ message: "unavailable " + config.apiKey }), { status: 400 }); } }), e => e instanceof Error && !e.message.includes(config.apiKey) && e.message.includes("unavailable"));
  assert.equal(calls, 1);
  await assert.rejects(() => requestOpenAIVideo(config, { prompt: "ball" }, { fetchImpl: async () => json({ id: "one", status: "failed", error: { message: "pipeline failed" } }) }), /pipeline failed/);
});

test("cancellation and deadline interrupt polling and stalled download bodies", async t => {
  const { store } = await fixture(t);
  const response = await requestOpenAIVideo(config, { prompt: "ball" }, { timeoutMs: 30, fetchImpl: async url => String(url).endsWith("/content") ? new Response(new ReadableStream()) : json({ id: "one", status: "completed" }) });
  await assert.rejects(() => store.save("stalled", response), /cancelled|timed out/);
  assert.deepEqual(await store.list("stalled"), []);
  await assert.rejects(() => requestOpenAIVideo(config, { prompt: "ball" }, { timeoutMs: 10, pollMs: 100, fetchImpl: async () => json({ id: "one", status: "queued" }) }), /timed out/);
});


test("model defaults are sent as JSON form parameters and tools can override the composition", async () => {
  let fields: Record<string, unknown> = {};
  const response = await requestOpenAIVideo({ ...config, extraParams: { task: "t2va", aspect_ratio: "16:9" } }, { prompt: "square ball", extra_params: { aspect_ratio: "1:1" }, num_inference_steps: 8 }, { fetchImpl: async (url, init) => {
    if (init?.method === "POST") fields = Object.fromEntries((init.body as unknown as import("undici").FormData).entries());
    return upstream(url);
  } });
  await response.body?.cancel();
  assert.equal(fields.seconds, "5"); assert.equal(fields.num_inference_steps, "8");
  assert.deepEqual(JSON.parse(fields.extra_params as string), { task: "t2va", aspect_ratio: "1:1" });
});
