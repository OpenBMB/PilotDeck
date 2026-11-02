import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createSubagentImageInheritance, createSubagentImagePreparation } from "../../src/cli/subagentImageInheritance.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import { ImageStore, type GeneratedImage } from "../../src/tool/builtin/images/ImageStore.js";
import type { PilotDeckToolSuccessResult } from "../../src/tool/index.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";
import type { PilotConfigSnapshot } from "../../src/pilot/config/types.js";
import { createProjectId } from "../../src/pilot/index.js";

test("same-chat parent saves and edits parallel child images by ID, including after gateway restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "subagent-images-"));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace); await mkdir(join(home, "skills"));
  const registration = join(home, "projects", createProjectId(workspace));
  await mkdir(registration, { recursive: true }); await writeFile(join(registration, ".cwd"), workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
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
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
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
  const modelRequests: CanonicalModelRequest[] = [];
  const options = { pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, "skills"),
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: join(home, "pilotdeck.yaml") },
    __testModelFactory: (snapshot: PilotConfigSnapshot) => ({
      ...createModelRuntime(snapshot.config.model),
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        modelRequests.push(request);
        const results = request.messages.flatMap(message => message.content.filter(block => block.type === "tool_result"));
        const has = (id: string) => results.some(block => block.toolCallId === id);
        const userText = request.messages.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text));
        const inherited = results.filter(block => block.toolCallId.startsWith("delegate-"));
        const ids = [...new Set(inherited.flatMap(block => [...JSON.stringify(block.content).matchAll(/image_id: ([0-9a-f-]{36})/g)].map(match => match[1]!)))];
        let calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
        if (request.metadata?.subagentId) {
          if (!has("draw")) calls = [{ id: "draw", name: "generate_image", input: { prompt: "blue circle", purpose: "deliverable" } }];
        } else if (userText.some(text => text.startsWith("isolated:"))) {
          const id = userText.find(text => text.startsWith("isolated:"))!.slice(9);
          if (!has("isolated-save")) calls = [
            { id: "isolated-save", name: "save_generated_image", input: { image_id: id, output_path: "must-not-exist.png" } },
            { id: "isolated-edit", name: "edit_image", input: { image_ids: [id], prompt: "red circle", purpose: "deliverable" } },
          ];
        } else if (userText.includes("again")) {
          if (!has("reloaded-save")) calls = [
            { id: "reloaded-save", name: "save_generated_image", input: { image_id: ids[0], output_path: "reloaded.png" } },
            { id: "reloaded-edit", name: "edit_image", input: { image_ids: [ids[0]], prompt: "green circle", purpose: "deliverable" } },
          ];
        } else if (!has("delegate-0")) {
          calls = [0, 1].map(i => ({ id: `delegate-${i}`, name: "agent", input: { description: `Draw image ${i}`, prompt: "Draw a blue circle", subagent_type: "general-purpose" } }));
        } else if (!has("parent-save-0")) {
          assert.equal(ids.length, 2, "host appends both registered image IDs even when child report omits them");
          for (const id of ids) {
            const image = await new ImageStore(join(home, "generated-images")).get("web:parent", id);
            assert.ok(JSON.stringify(inherited).includes(image.path), "model receives parent-owned attachment paths before its next call");
          }
          calls = ids.map((id, i) => ({ id: `parent-save-${i}`, name: "save_generated_image", input: { image_id: id, output_path: `parent-${i}.png` } }));
          calls.push({ id: "parent-edit", name: "edit_image", input: { image_ids: [ids[0]], prompt: "red circle", purpose: "deliverable" } });
        }
        yield { type: "message_start", role: "assistant" };
        for (const call of calls) {
          yield { type: "tool_call_start", id: call.id, name: call.name };
          yield { type: "tool_call_end", toolCall: call };
        }
        if (!calls.length) yield { type: "text_delta", text: "Scope: drawing\nResult: done\nKey files: none\nFiles changed: none\nIssues: none" };
        yield { type: "message_end", finishReason: calls.length ? "tool_call" : "stop" };
      },
      async complete() { return { role: "assistant" as const, content: [{ type: "text" as const, text: '{"title":"Image QA"}' }], finishReason: "stop" as const }; },
    }),
  };
  let local = createLocalGateway(options);
  t.after(() => local.dispose());
  const submit = async (message: string, sessionKey = "web:parent") => {
    const events: GatewayEvent[] = [];
    for await (const event of local.gateway.submitTurn({ projectKey: workspace, sessionKey, channelKey: "web", mode: "bypassPermissions", message })) events.push(event);
    assert.ok(events.some(event => event.type === "turn_completed" && event.finishReason === "completed"), JSON.stringify(events.filter(event => event.type === "error" || event.type === "turn_completed" || event.type === "tool_call_finished")));
    assert.deepEqual(events.filter(event => event.type === "error"), []);
    return events;
  };
  const events = await submit("delegate");
  const finished = events.filter(event => event.type === "tool_call_finished");
  assert.deepEqual(finished.map(event => [event.toolName, event.ok]).sort(), [
    ["agent", true], ["agent", true], ["edit_image", true], ["save_generated_image", true], ["save_generated_image", true],
  ].sort());
  const childImages = events.filter((event): event is Extract<GatewayEvent, { type: "agent_status" }> => event.type === "agent_status" && event.event === "subagent_tool_result")
    .map(event => (event.detail as { data: { imageGeneration: GeneratedImage } }).data.imageGeneration);
  assert.equal(childImages.length, 2);
  assert.notEqual(childImages[0]!.imageId, childImages[1]!.imageId);
  assert.notEqual(childImages[0]!.sessionId, childImages[1]!.sessionId);
  for (const image of childImages) {
    assert.notEqual(image.sessionId, "web:parent");
    assert.deepEqual(await readFile(image.path), png, "child original remains usable for live preview");
    const parent = await new ImageStore(join(home, "generated-images")).get("web:parent", image.imageId);
    assert.deepEqual(await readFile(parent.path), png);
    await assert.rejects(() => new ImageStore(join(home, "generated-images")).get("web:unrelated", image.imageId), /ENOENT/);
  }
  assert.equal(events.filter(event => event.type === "assistant_attachment").length, 3, "handoff does not send the two child images twice");
  const files = (await readdir(workspace)).filter(file => file !== ".pilotdeck");
  assert.deepEqual(files, ["parent-0.png", "parent-1.png"], "only the parent's explicit saves write project files");
  for (const file of files) assert.deepEqual(await readFile(join(workspace, file)), png);
  assert.deepEqual(requests.map(request => request.path).sort(), ["/v1/images/generations", "/v1/images/generations", "/v1/images/edits"].sort());
  assert.deepEqual(requests.find(request => request.reference)!.reference, png);

  // Remove every child attachment, then reload the parent from durable history.
  for (const image of childImages) await rm(join(image.path, ".."), { recursive: true });
  local.dispose(); local = createLocalGateway(options);
  const reloaded = await submit("again");
  assert.deepEqual(reloaded.filter(event => event.type === "tool_call_finished").map(event => event.ok), [true, true]);
  assert.deepEqual(await readFile(join(workspace, "reloaded.png")), png);
  assert.equal(requests.length, 4, "saving never regenerates, editing performs exactly one request");
  assert.deepEqual(requests.at(-1)!.reference, png);
  const isolated = await submit(`isolated:${childImages[0]!.imageId}`, "web:unrelated");
  assert.deepEqual(isolated.filter(event => event.type === "tool_call_finished").map(event => event.ok), [false, false]);
  assert.equal(requests.length, 4, "unrelated chats cannot reuse an ID from another session");
  assert.ok(modelRequests.some(request => request.metadata?.subagentId), "exercise real forked AgentLoops, not a synthetic event mapper");
});

test("child image handoff tolerates concurrent replay, preserves originals and rejects wrong ownership", async t => {
  const root = await mkdtemp(join(tmpdir(), "image-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
  const store = new ImageStore(root), image = await store.save("child", png);
  const inherit = createSubagentImageInheritance(store);
  const result: PilotDeckToolSuccessResult = { type: "success", toolName: "generate_image", toolCallId: "draw", content: [],
    data: { imageGeneration: image }, startedAt: "", completedAt: "" };
  const args = { parentSessionId: "parent", subagentSessionId: "child", result };
  const copies = await Promise.all(Array.from({ length: 5 }, () => inherit(args)));
  assert.equal(new Set(copies.map(copy => copy!.description)).size, 1);
  const inherited = await store.get("parent", image.imageId);
  assert.deepEqual(await readFile(inherited.path), png);
  assert.deepEqual(await readFile(image.path), png);
  assert.deepEqual(await createSubagentImageInheritance(new ImageStore(root))(args), copies[0], "replay after restart is idempotent too");
  await assert.rejects(() => inherit({ ...args, subagentSessionId: "unrelated" }), /does not belong/);
  assert.equal(await inherit({ ...args, result: { ...result, toolName: "other_tool" } }), undefined);
  await writeFile(inherited.path, "conflicting bytes");
  await assert.rejects(() => inherit(args), /conflicts/);
  assert.equal(await readFile(inherited.path, "utf8"), "conflicting bytes", "never overwrite an existing conflicting attachment");
});

test("delegation snapshots only the parent's images, supports replay and exposes nothing when disabled", async t => {
  const root = await mkdtemp(join(tmpdir(), "parent-image-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
  const store = new ImageStore(root);
  const first = await store.save("parent", png, undefined, "intermediate");
  const second = await store.save("parent", png);
  const unrelated = await store.save("unrelated", png);
  let enabled = false;
  const prepare = createSubagentImagePreparation(store, () => enabled);
  const args = { parentSessionId: "parent", subagentSessionId: "child" };
  assert.deepEqual(await prepare(args), []);
  assert.deepEqual(await store.list("child"), []);
  enabled = true;
  const inherited = await prepare(args);
  assert.deepEqual(inherited.map(image => image.key).sort(), [first.imageId, second.imageId].sort());
  assert.deepEqual(await prepare(args), inherited, "preparation can be replayed without duplicate copies");
  for (const source of [first, second]) {
    const child = await store.get("child", source.imageId);
    assert.notEqual(child.path, source.path);
    assert.equal(child.purpose, source.purpose);
    assert.ok(inherited.find(item => item.key === source.imageId)!.description.includes(child.path));
    assert.deepEqual(await readFile(child.path), png);
  }
  await assert.rejects(() => store.get("child", unrelated.imageId), /ENOENT/);
  assert.deepEqual(await prepare({ parentSessionId: "empty", subagentSessionId: "empty-child" }), []);
  const signal = AbortSignal.abort();
  await assert.rejects(() => prepare({ ...args, subagentSessionId: "aborted-child", abortSignal: signal }), { name: "AbortError" });
  assert.deepEqual(await store.list("aborted-child"), []);
});
