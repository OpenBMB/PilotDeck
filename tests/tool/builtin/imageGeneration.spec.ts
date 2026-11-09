import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FormData } from "undici";
import sharp from "sharp";
import { ImageStore, type GeneratedImage } from "../../../src/tool/builtin/images/ImageStore.js";
import { createImageGenerationTools } from "../../../src/tool/builtin/imageGeneration.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { requestOpenAIImage } from "../../../src/tool/builtin/images/openaiImages.js";
import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { resolvePilotDeckWorkspacePath } from "../../../src/tool/builtin/filesystem/pathSafety.js";

function context(cwd: string, home: string): PilotDeckToolRuntimeContext {
  return { sessionId: "session-a", turnId: "turn-1", cwd, env: { PILOT_HOME: home }, permissionMode: "default",
    permissionContext: { mode: "default", cwd, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] }, canPrompt: true, bypassAvailable: true } };
}
const config = { enabled: true, apiKey: "secret-test-key", baseUrl: "https://images.example/v1", model: "image-model" };

test("image requests transmit JSON and multipart data through the production HTTP transport", async () => {
  const received: Array<{ path?: string; contentType: string; body: Buffer }> = [];
  const result = Buffer.from("image-response");
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url, contentType: request.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ b64_json: result.toString("base64") }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const reference = { bytes: Buffer.from([0, 255, 10, 13, 128]), mimeType: "image/jpeg" };
  try {
    assert.deepEqual(await requestOpenAIImage({ ...config, baseUrl }, { prompt: "画一只猫" }), result);
    assert.equal(received[0]?.path, "/v1/images/generations");
    assert.equal(received[0]?.contentType, "application/json");
    assert.deepEqual(JSON.parse(received[0]!.body.toString()), { model: config.model, prompt: "画一只猫", n: 1 });

    for (const references of [[reference], [reference, { bytes: Buffer.from("second image"), mimeType: "image/png" }]]) {
      assert.deepEqual(await requestOpenAIImage({ ...config, baseUrl }, {
        prompt: "把背景改成蓝色", references, size: "1536x1024", quality: "high", background: "opaque",
      }), result);
      const request = received.at(-1)!;
      assert.equal(request.path, "/v1/images/edits");
      assert.match(request.contentType, /^multipart\/form-data; boundary=/);
      const form = await new Request(baseUrl, { method: "POST", headers: { "content-type": request.contentType }, body: new Uint8Array(request.body) }).formData();
      assert.equal(form.get("model"), config.model);
      assert.equal(form.get("prompt"), "把背景改成蓝色");
      assert.equal(form.get("n"), "1");
      assert.equal(form.get("size"), "1536x1024");
      assert.equal(form.get("quality"), "high");
      assert.equal(form.get("background"), "opaque");
      const files = form.getAll(references.length === 1 ? "image" : "image[]") as File[];
      assert.equal(files.length, references.length);
      for (const [index, file] of files.entries()) {
        assert.equal(file.type, references[index]!.mimeType);
        assert.equal(file.name, `reference-${index}.${index === 0 ? "jpg" : "png"}`);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), references[index]!.bytes);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("image generation requires an explicit opt-in, including already-created tool closures", async () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  assert.equal(parseToolsConfig({ imageGeneration: { apiKey: "key", model: "image" } }, diagnostics)?.imageGeneration?.enabled, false);
  assert.deepEqual(diagnostics, []);
  let current = { ...config, enabled: false };
  const options = { store: new ImageStore("/unused"), getConfig: () => current, fetchImpl: async () => { throw new Error("must not fetch"); } };
  assert.equal(createBuiltinRegistry({ imageGeneration: options }).has("generate_image"), false);
  current = { ...current, enabled: true };
  const registry = createBuiltinRegistry({ imageGeneration: options });
  assert.ok(registry.has("generate_image"));
  for (const name of ["generate_image", "edit_image"]) {
    const tool = registry.get(name)!;
    assert.ok((tool.inputSchema.required as string[]).includes("purpose"));
    assert.deepEqual((tool.inputSchema.properties as Record<string, { enum?: string[] }>).purpose!.enum, ["intermediate", "deliverable"]);
    assert.equal((await tool.validateInput!({ prompt: "cat", purpose: "unknown" }, context("/project", "/home"))).ok, false);
  }
  current = { ...current, enabled: false };
  await assert.rejects(() => registry.get("generate_image")!.execute({ prompt: "cat" }, context("/project", "/home")), /disabled/);
});

test("generated images persist outside the project, remain session-scoped, and can be exported without regeneration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-image-test-"));
  try {
    const cwd = join(root, "project"); const home = join(root, "home");
    await mkdir(cwd);
    const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: "red" } }).png().toBuffer();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const store = new ImageStore(join(home, "generated-images"));
    const tools = createImageGenerationTools({ store, getConfig: () => config, fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } });
    const ctx = context(cwd, home);
    const generated = await tools[0]!.execute({ prompt: "a cat", purpose: "intermediate" }, ctx);
    const image = (generated.data as { imageGeneration: GeneratedImage }).imageGeneration;
    assert.deepEqual(await readdir(cwd), []);
    assert.ok(!generated.content.some(item => item.type === "file"));
    assert.deepEqual(await readFile(image.path), png);
    assert.equal(image.purpose, "intermediate");
    assert.equal((await store.get(ctx.sessionId, image.imageId)).purpose, "intermediate");
    assert.equal(calls[0]?.url, "https://images.example/v1/images/generations");
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).model, "image-model");
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).purpose, undefined);
    assert.equal(resolvePilotDeckWorkspacePath(image.path, ctx, { mustExist: true, allowRegisteredReadFiles: true }).ok, true);
    assert.equal(resolvePilotDeckWorkspacePath(image.path, { ...ctx, sessionId: "session-b" }, { mustExist: true, allowRegisteredReadFiles: true }).ok, false);
    await assert.rejects(() => store.get("session-b", image.imageId));
    const saved = await tools[2]!.execute({ image_id: image.imageId, output_path: "assets/cat.jpg" }, ctx);
    assert.equal(calls.length, 1);
    assert.ok(!saved.content.some(item => item.type === "file"), "saving does not deliver the image again");
    assert.equal((saved.data as { imageGeneration: GeneratedImage }).imageGeneration.purpose, "intermediate");
    assert.equal((await sharp(await readFile(join(cwd, "assets/cat.jpg"))).metadata()).format, "jpeg");
    await assert.rejects(() => tools[2]!.execute({ image_id: image.imageId, output_path: "assets/cat.jpg" }, ctx), /already exists/);
    await assert.rejects(() => tools[2]!.execute({ image_id: image.imageId, output_path: "../escape.png" }, ctx), /outside/);
    await symlink(home, join(cwd, "escape"));
    await assert.rejects(() => tools[2]!.execute({ image_id: image.imageId, output_path: "escape/escape.png" }, ctx), /outside|not allowed/);
    const edited = await tools[1]!.execute({ prompt: "make it blue", purpose: "deliverable", image_ids: [image.imageId], output_path: "assets/edited.png" }, ctx);
    const editedImage = (edited.data as { imageGeneration: GeneratedImage }).imageGeneration;
    assert.equal(editedImage.purpose, "deliverable");
    assert.ok(editedImage.savedTo?.endsWith("assets/edited.png"));
    assert.equal((await store.get(ctx.sessionId, editedImage.imageId)).purpose, "deliverable");
    assert.equal(calls[1]?.url, "https://images.example/v1/images/edits");
    assert.ok(calls[1]?.init?.body instanceof FormData);
    assert.ok((calls[1]!.init!.body as FormData).get("image") instanceof Blob);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("URL responses never forward the provider key to image downloads; errors redact credentials", async () => {
  let count = 0;
  const bytes = Buffer.from("image bytes");
  const fetched = await requestOpenAIImage(config, { prompt: "cat" }, { fetchImpl: async (_url, init) => {
    if (count++ === 0) return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.png" }] }));
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return new Response(bytes);
  } });
  assert.deepEqual(fetched, bytes);
  await assert.rejects(() => requestOpenAIImage(config, { prompt: "cat" }, { fetchImpl: async () => new Response(JSON.stringify({ error: { message: "invalid secret-test-key" } }), { status: 401 }) }), error => {
    assert.ok(!(error as Error).message.includes(config.apiKey)); return true;
  });
});

test("cancellation interrupts a response body without automatically retrying a paid request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = requestOpenAIImage(config, { prompt: "cat" }, { signal: controller.signal, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(new Error("cancelled")), 10); } }));
  } });
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(calls, 1);
});
