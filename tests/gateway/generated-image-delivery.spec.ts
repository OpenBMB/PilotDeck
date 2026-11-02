import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createImageGenerationTools } from "../../src/tool/builtin/imageGeneration.js";
import { ImageStore, type GeneratedImage } from "../../src/tool/builtin/images/ImageStore.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import { ImAttachmentDelivery, type PreparedImAttachment } from "../../src/adapters/channel/protocol/ImAttachmentDelivery.js";
import type { PilotDeckToolRuntimeContext, PilotDeckToolExecutionOutput } from "../../src/tool/protocol/types.js";

test("generated deliverables reach IM as the original image once, without requiring project export", async t => {
  const root = await mkdtemp(join(tmpdir(), "image-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"); await mkdir(cwd);
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
  const store = new ImageStore(join(root, "generated-images"));
  const tools = createImageGenerationTools({ store,
    getConfig: () => ({ enabled: true, apiKey: "test-key", model: "image-model" }),
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })),
  });
  const context: PilotDeckToolRuntimeContext = { sessionId: "im-session", turnId: "turn", cwd,
    permissionMode: "default", env: { PILOT_HOME: root },
    permissionContext: { mode: "default", cwd, additionalWorkingDirectories: [], rules: { allow: [], deny: [], ask: [] }, canPrompt: false, bypassAvailable: false } };
  const delivered: PreparedImAttachment[] = [];
  const delivery = new ImAttachmentDelivery({ maxBytes: 32 * 1024 * 1024,
    sendPrepared: async attachment => { delivered.push(attachment); },
    sendTextFallback: async text => { assert.fail(text); },
  });
  const forward = async (toolName: string, output: PilotDeckToolExecutionOutput) => {
    const events = mapAgentEvent({ type: "tool_result", sessionId: context.sessionId, turnId: "turn",
      result: { ...output, type: "success", toolName, toolCallId: "call", startedAt: "", completedAt: "" } }, "run");
    const attachments = events.filter(event => event.type === "assistant_attachment");
    for (const event of attachments) assert.equal(await delivery.send(event.attachment), true);
    return attachments;
  };
  const imageOf = (output: PilotDeckToolExecutionOutput) => (output.data as { imageGeneration: GeneratedImage }).imageGeneration;
  const first = await tools[0]!.execute({ prompt: "blue circle", purpose: "deliverable" }, context);
  const image = imageOf(first);
  assert.deepEqual(await readdir(cwd), []);
  assert.equal((await forward("generate_image", first)).length, 1);
  assert.equal(delivered[0]!.fileType, "image");
  assert.equal(delivered[0]!.path, image.path);
  assert.deepEqual(delivered[0]!.buffer, await readFile(image.path));

  const edited = await tools[1]!.execute({ prompt: "red circle", purpose: "deliverable", image_ids: [image.imageId], output_path: "edited.jpg" }, context);
  assert.equal((await forward("edit_image", edited)).length, 1);
  assert.equal(delivered[1]!.path, imageOf(edited).path, "export does not create a second delivery");
  const saved = await tools[2]!.execute({ image_id: image.imageId, output_path: "saved.png" }, context);
  assert.equal((await forward("save_generated_image", saved)).length, 0);
  const asset = await tools[0]!.execute({ prompt: "website material", purpose: "intermediate", output_path: "asset.png" }, context);
  assert.equal((await forward("generate_image", asset)).length, 0);

  await writeFile(join(cwd, "exists.png"), "existing");
  const exportFailed = await tools[0]!.execute({ prompt: "blue circle", purpose: "deliverable", output_path: "exists.png" }, context);
  assert.equal((await forward("generate_image", exportFailed)).length, 1, "a failed export still delivers the generated session original");
  assert.equal(await readFile(join(cwd, "exists.png"), "utf8"), "existing");
  assert.equal(delivered.length, 3);
  const childEvents = mapAgentEvent({ type: "subagent_tool_result", sessionId: context.sessionId, turnId: "turn",
    subagentId: "child", subagentType: "general-purpose", result: { ...first, type: "success", toolName: "generate_image",
      toolCallId: "child-draw", startedAt: "", completedAt: "" } }, "run");
  const childAttachments = childEvents.filter(event => event.type === "assistant_attachment");
  assert.equal(childAttachments.length, 1, "delegated final images use the same IM delivery contract");
  for (const event of childAttachments) await delivery.send(event.attachment);
  assert.equal(delivered[3]!.fileType, "image");
  assert.deepEqual(delivered[3]!.buffer, png);
});
