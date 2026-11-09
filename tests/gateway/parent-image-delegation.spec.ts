import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import { createProjectId } from "../../src/pilot/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/config/types.js";
import { ImageStore, type GeneratedImage } from "../../src/tool/builtin/images/ImageStore.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

for (const source of ["parent", "sibling"] as const) {
  test(`${source}-generated image survives restart and is edited/saved by a new child using its original ID`, async t => {
    const root = await mkdtemp(join(tmpdir(), "parent-image-delegation-"));
    let local: ReturnType<typeof createLocalGateway>;
    const home = join(root, "home"), workspace = join(root, "workspace");
    await mkdir(home); await mkdir(workspace); await mkdir(join(home, "skills"));
    t.after(async () => { local?.dispose(); await rm(root, { recursive: true, force: true }); });
    const registration = join(home, "projects", createProjectId(workspace));
    await mkdir(registration, { recursive: true }); await writeFile(join(registration, ".cwd"), workspace);
    const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
    const editedPng = await sharp({ create: { width: 24, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    const requests: { path: string; reference?: Buffer }[] = [];
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request: typeof requests[number] = { path: req.url! };
        if (req.url!.endsWith("/edits")) {
          const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"]! } }).formData();
          request.reference = Buffer.from(await (form.get("image") as File).arrayBuffer());
        }
        requests.push(request);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: (request.reference ? editedPng : png).toString("base64") }] }));
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
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
  imageGeneration: { enabled: true, apiKey: image-key, model: image-model, baseUrl: "http://127.0.0.1:${port}/v1" }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models: { model: {} }
`);
    const sessionId = "web:delegation", store = new ImageStore(join(home, "generated-images"));
    const unrelated = await store.save("web:unrelated", png);
    const options = { pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, "skills"),
      env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: join(home, "pilotdeck.yaml") },
      __testModelFactory: (snapshot: PilotConfigSnapshot) => ({
        ...createModelRuntime(snapshot.config.model),
        async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
          const results = request.messages.flatMap(message => message.content.filter(block => block.type === "tool_result"));
          const has = (id: string) => results.some(block => block.toolCallId === id);
          const ids = (id: string) => [...new Set([...JSON.stringify(results.find(block => block.toolCallId === id)?.content).matchAll(/image_id: ([0-9a-f-]{36})/g)].map(match => match[1]!))];
          const texts = request.messages.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text));
          let calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
          if (request.metadata?.subagentId) {
            const directive = texts[0]!;
            if (directive === "produce") {
              if (!has("draw")) calls = [{ id: "draw", name: "generate_image", input: { prompt: "blue circle", purpose: "deliverable" } }];
            } else if (!has("child-save")) {
              const imageId = directive.match(/image_id: ([0-9a-f-]{36})/)![1]!;
              const childSession = `${workspace}::sub::${request.metadata.subagentId}`;
              const inherited = await store.get(childSession, imageId);
              assert.deepEqual((await store.list(childSession)).map(image => image.imageId), [imageId]);
              assert.ok(texts.some(text => text.includes(inherited.path)), "child sees its own attachment path before the first tool call");
              assert.ok(!texts.join("\n").includes(unrelated.imageId));
              // The already-prepared child must not depend on the parent's files.
              await rm(dirname((await store.get(sessionId, imageId)).path), { recursive: true });
              calls = [
                { id: "child-save", name: "save_generated_image", input: { image_id: imageId, output_path: "child-original.png" } },
                { id: "child-edit", name: "edit_image", input: { image_ids: [imageId], prompt: "red circle", purpose: "deliverable" } },
              ];
            }
          } else if (texts.includes("consume")) {
            const imageId = ids("seed")[0]!;
            assert.ok(imageId);
            if (!has("consumer")) calls = [{ id: "consumer", name: "agent", input: { description: "Edit inherited image", prompt: `consume image_id: ${imageId}`, subagent_type: "general-purpose" } }];
            else if (!has("parent-save")) {
              const newIds = ids("consumer").filter(id => id !== imageId);
              assert.equal(newIds.length, 1, "edited child output returns to the parent with a usable ID");
              calls = [{ id: "parent-save", name: "save_generated_image", input: { image_id: newIds[0], output_path: "parent-edited.png" } }];
            }
          } else if (!has("seed")) {
            calls = source === "parent"
              ? [{ id: "seed", name: "generate_image", input: { prompt: "blue circle", purpose: "deliverable" } }]
              : [{ id: "seed", name: "agent", input: { description: "Produce original image", prompt: "produce", subagent_type: "general-purpose" } }];
          }
          yield { type: "message_start", role: "assistant" };
          for (const call of calls) {
            yield { type: "tool_call_start", id: call.id, name: call.name };
            yield { type: "tool_call_end", toolCall: call };
          }
          if (!calls.length) yield { type: "text_delta", text: "Scope: image task\nResult: done\nKey files: none\nFiles changed: none\nIssues: none" };
          yield { type: "message_end", finishReason: calls.length ? "tool_call" : "stop" };
        },
        async complete() { return { role: "assistant" as const, content: [{ type: "text" as const, text: '{"title":"Image delegation"}' }], finishReason: "stop" as const }; },
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
      const producerImage = seeded.flatMap(event => event.type === "agent_status" && event.event === "subagent_tool_result"
        ? [(event.detail as { data: { imageGeneration: GeneratedImage } }).data.imageGeneration] : [])[0]!;
      await rm(dirname(producerImage.path), { recursive: true });
    }
    local.dispose(); local = createLocalGateway(options);
    const consumed = await submit("consume");
    assert.deepEqual(consumed.filter(event => event.type === "tool_call_finished").map(event => [event.toolName, event.ok]), [["agent", true], ["save_generated_image", true]]);
    const childResults = consumed.flatMap(event => event.type === "agent_status" && event.event === "subagent_tool_result"
      ? [event.detail as { toolName: string; ok: boolean; data: { imageGeneration: GeneratedImage } }] : []);
    assert.deepEqual(childResults.map(result => [result.toolName, result.ok]).sort(), [["edit_image", true], ["save_generated_image", true]]);
    assert.equal(childResults.find(result => result.toolName === "save_generated_image")!.data.imageGeneration.imageId, original.imageId);
    const edited = childResults.find(result => result.toolName === "edit_image")!.data.imageGeneration;
    assert.deepEqual(await readFile(join(workspace, "child-original.png")), png);
    assert.deepEqual(await readFile(join(workspace, "parent-edited.png")), editedPng);
    assert.deepEqual(await readFile((await store.get(sessionId, edited.imageId)).path), editedPng);
    assert.deepEqual(requests.map(request => request.path), ["/v1/images/generations", "/v1/images/edits"]);
    assert.deepEqual(requests[1]!.reference, png, "edit request contains the original inherited bytes");
    assert.equal([...seeded, ...consumed].filter(event => event.type === "assistant_attachment").length, 2, "preparation and saving do not redeliver inherited originals");
    await assert.rejects(() => store.get("web:unrelated", edited.imageId), /ENOENT/);
  });
}
