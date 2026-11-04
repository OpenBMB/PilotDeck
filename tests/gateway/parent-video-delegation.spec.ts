import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import { createProjectId } from "../../src/pilot/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/config/types.js";
import { VideoStore, type GeneratedVideo } from "../../src/tool/builtin/videos/VideoStore.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

for (const source of ["parent", "sibling"] as const) {
  test(`${source}-generated video survives restart and is saved and reused by a new child using its original ID`, async t => {
    const root = await mkdtemp(join(tmpdir(), "parent-video-delegation-"));
    let local: ReturnType<typeof createLocalGateway>;
    const home = join(root, "home"), workspace = join(root, "workspace");
    await mkdir(home); await mkdir(workspace); await mkdir(join(home, "skills"));
    t.after(async () => { local?.dispose(); await rm(root, { recursive: true, force: true }); });
    const registration = join(home, "projects", createProjectId(workspace));
    await mkdir(registration, { recursive: true }); await writeFile(join(registration, ".cwd"), workspace);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from("original-blue-video-fixture")]);
    const editedMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from("second-red-video-fixture")]);
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain multipart upload */ }
      requests.push(req.url!);
      if (req.url!.endsWith("/content")) { res.setHeader("content-type", "video/mp4"); res.end(requests.filter(p => p === "/v1/videos").length === 1 ? mp4 : editedMp4); }
      else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "fixture-job", status: "completed" })); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    await writeFile(join(home, "pilotdeck.yaml"), `schemaVersion: 1
agent: { model: test/model, maxContextTokens: 65536, maxOutputTokens: 8192 }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
tools:
  videoGeneration: { enabled: true, apiKey: video-key, model: video-model, baseUrl: "http://127.0.0.1:${port}/v1" }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models: { model: {} }
`);
    const sessionId = "web:delegation", store = new VideoStore(join(home, "generated-videos"));
    const unrelated = await store.save("web:unrelated", new Response(new Uint8Array(mp4)));
    const options = { pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, "skills"),
      env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: join(home, "pilotdeck.yaml") },
      __testModelFactory: (snapshot: PilotConfigSnapshot) => ({
        ...createModelRuntime(snapshot.config.model),
        async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
          const results = request.messages.flatMap(message => message.content.filter(block => block.type === "tool_result"));
          const has = (id: string) => results.some(block => block.toolCallId === id);
          const ids = (id: string) => [...new Set([...JSON.stringify(results.find(block => block.toolCallId === id)?.content).matchAll(/video_id: ([0-9a-f-]{36})/g)].map(match => match[1]!))];
          const texts = request.messages.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text));
          let calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
          if (request.metadata?.subagentId) {
            const directive = texts[0]!;
            if (directive === "produce") {
              if (!has("draw")) calls = [{ id: "draw", name: "generate_video", input: { prompt: "blue circle", purpose: "deliverable" } }];
            } else if (!has("child-save")) {
              const videoId = directive.match(/video_id: ([0-9a-f-]{36})/)![1]!;
              const childSession = `${workspace}::sub::${request.metadata.subagentId}`;
              const inherited = await store.get(childSession, videoId);
              assert.deepEqual((await store.list(childSession)).map(video => video.videoId), [videoId]);
              assert.ok(texts.some(text => text.includes(inherited.path)), "child sees its own attachment path before the first tool call");
              assert.ok(!texts.join("\n").includes(unrelated.videoId));
              // The already-prepared child must not depend on the parent's files.
              await rm(dirname((await store.get(sessionId, videoId)).path), { recursive: true });
              calls = [
                { id: "child-save", name: "save_generated_video", input: { video_id: videoId, output_path: "child-original.mp4" } },
                { id: "child-generate", name: "generate_video", input: { prompt: "red circle", purpose: "deliverable" } },
              ];
            }
          } else if (texts.includes("consume")) {
            const videoId = ids("seed")[0]!;
            assert.ok(videoId);
            if (!has("consumer")) calls = [{ id: "consumer", name: "agent", input: { description: "Edit inherited video", prompt: `consume video_id: ${videoId}`, subagent_type: "general-purpose" } }];
            else if (!has("parent-save")) {
              const newIds = ids("consumer").filter(id => id !== videoId);
              assert.equal(newIds.length, 1, "edited child output returns to the parent with a usable ID");
              calls = [{ id: "parent-save", name: "save_generated_video", input: { video_id: newIds[0], output_path: "parent-edited.mp4" } }];
            }
          } else if (!has("seed")) {
            calls = source === "parent"
              ? [{ id: "seed", name: "generate_video", input: { prompt: "blue circle", purpose: "deliverable" } }]
              : [{ id: "seed", name: "agent", input: { description: "Produce original video", prompt: "produce", subagent_type: "general-purpose" } }];
          }
          yield { type: "message_start", role: "assistant" };
          for (const call of calls) {
            yield { type: "tool_call_start", id: call.id, name: call.name };
            yield { type: "tool_call_end", toolCall: call };
          }
          if (!calls.length) yield { type: "text_delta", text: "Scope: video task\nResult: done\nKey files: none\nFiles changed: none\nIssues: none" };
          yield { type: "message_end", finishReason: calls.length ? "tool_call" : "stop" };
        },
        async complete() { return { role: "assistant" as const, content: [{ type: "text" as const, text: '{"title":"Video delegation"}' }], finishReason: "stop" as const }; },
      }),
    };
    local = createLocalGateway(options);
    const submit = async (message: string) => {
      const events: GatewayEvent[] = [];
      for await (const event of local.gateway.submitTurn({ projectKey: workspace, sessionKey: sessionId, channelKey: "web", mode: "bypassPermissions", message })) events.push(event);
      assert.ok(events.some(event => event.type === "turn_completed" && event.finishReason === "completed"), JSON.stringify(events.filter(event => event.type === "error" || event.type === "tool_call_finished")));
      return events;
    };
    const seeded = await submit("seed");
    const original = (await store.list(sessionId))[0]!;
    assert.ok(original);
    if (source === "sibling") {
      const producerVideo = seeded.flatMap(event => event.type === "agent_status" && event.event === "subagent_tool_result"
        ? [(event.detail as { data: { videoGeneration: GeneratedVideo } }).data.videoGeneration] : [])[0]!;
      await rm(dirname(producerVideo.path), { recursive: true });
    }
    local.dispose(); local = createLocalGateway(options);
    const consumed = await submit("consume");
    assert.deepEqual(consumed.filter(event => event.type === "tool_call_finished").map(event => [event.toolName, event.ok]), [["agent", true], ["save_generated_video", true]]);
    const childResults = consumed.flatMap(event => event.type === "agent_status" && event.event === "subagent_tool_result"
      ? [event.detail as { toolName: string; ok: boolean; data: { videoGeneration: GeneratedVideo } }] : []);
    assert.deepEqual(childResults.map(result => [result.toolName, result.ok]).sort(), [["generate_video", true], ["save_generated_video", true]]);
    assert.equal(childResults.find(result => result.toolName === "save_generated_video")!.data.videoGeneration.videoId, original.videoId);
    const edited = childResults.find(result => result.toolName === "generate_video")!.data.videoGeneration;
    assert.deepEqual(await readFile(join(workspace, "child-original.mp4")), mp4);
    assert.deepEqual(await readFile(join(workspace, "parent-edited.mp4")), editedMp4);
    assert.deepEqual(await readFile((await store.get(sessionId, edited.videoId)).path), editedMp4);
    assert.deepEqual(requests, ["/v1/videos", "/v1/videos/fixture-job/content", "/v1/videos", "/v1/videos/fixture-job/content"]);
    assert.equal([...seeded, ...consumed].filter(event => event.type === "assistant_attachment").length, 2, "preparation and saving do not redeliver inherited originals");
    await assert.rejects(() => store.get("web:unrelated", edited.videoId), /ENOENT/);
  });
}
