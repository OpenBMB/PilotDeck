import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";

import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import { materializeMediaReferences } from "../../src/model/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";

function context(cwd: string) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  };
}

test("large tool results are persisted under workspace .pilotdeck and readable by read_file", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-readable-tool-result-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-home-"));
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_test",
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    assert.match(relative(projectRoot, storage.toolResultsDir), /^\.pilotdeck[\/\\]tool-results[\/\\]/);

    const budget = new ToolResultBudget({
      toolResultsDir: storage.toolResultsDir,
      maxResultSizeChars: 64,
      maxResultSizeTokens: 20,
      previewBytes: 32,
    });
    const message = await budget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-large",
        content: [{ type: "text", text: `alpha\n${"x".repeat(200)}\nomega` }],
      }],
    }, { turnId: "turn-1" });

    const ref = message.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected a persisted tool_result_reference");
    assert.match(relative(projectRoot, ref.path), /^\.pilotdeck[\/\\]tool-results[\/\\]/);
    assert.equal(ref.readFilePath, ".pilotdeck/tool-results/refs/result-0001.txt");
    assert.equal(await readFile(join(projectRoot, ref.readFilePath), "utf8"), `alpha\n${"x".repeat(200)}\nomega`);

    const read = await createReadFileTool().execute({ file_path: ref.readFilePath, offset: 1, limit: 2 }, context(projectRoot));
    const text = read.content[0]?.type === "text" ? read.content[0].text : "";
    assert.match(text, /alpha/);
    assert.match(text, /2\|x+/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("large tool result read_file aliases are short and sequential", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-readable-tool-result-seq-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-home-"));
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_test",
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const budget = new ToolResultBudget({
      toolResultsDir: storage.toolResultsDir,
      maxResultSizeChars: 16,
      maxResultSizeTokens: 5,
      previewBytes: 8,
    });

    const first = await budget.applyToMessage({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-a", content: [{ type: "text", text: "first\n" + "a".repeat(80) }] }],
    }, { turnId: "turn-1" });
    const second = await budget.applyToMessage({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-b", content: [{ type: "text", text: "second\n" + "b".repeat(80) }] }],
    }, { turnId: "turn-1" });

    const firstRef = first.content.find((block) => block.type === "tool_result_reference");
    const secondRef = second.content.find((block) => block.type === "tool_result_reference");
    assert.ok(firstRef);
    assert.ok(secondRef);
    assert.equal(firstRef.readFilePath, ".pilotdeck/tool-results/refs/result-0001.txt");
    assert.equal(secondRef.readFilePath, ".pilotdeck/tool-results/refs/result-0002.txt");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("host-owned tool-result payloads restore a read_file cache after a local restart", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-external-tool-result-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-home-"));
  const payloads = new Map<string, Uint8Array>();
  const payloadStore = {
    async write(name: string, bytes: Uint8Array) {
      payloads.set(name, bytes.slice());
    },
    async read(name: string) {
      return payloads.get(name)?.slice();
    },
    async delete(name: string) {
      payloads.delete(name);
    },
    async deleteAll() {
      payloads.clear();
    },
  };
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_external",
      now: () => new Date("2026-09-10T00:00:00.000Z"),
    });
    const original = `host-owned marker\n${"payload ".repeat(80)}`;
    const first = new ToolResultBudget({
      toolResultsDir: storage.toolResultsDir,
      artifactStorage: payloadStore,
      maxResultSizeChars: 64,
      maxResultSizeTokens: 20,
      previewBytes: 32,
    });
    const message = await first.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-host-owned",
        content: [{ type: "text", text: original }],
      }],
    }, { turnId: "turn-host-owned" });
    const reference = message.content.find((block) => block.type === "tool_result_reference");
    assert.ok(reference);
    assert.equal(
      new TextDecoder().decode(payloads.get(basename(reference.path))),
      original,
      "the durable host store receives the full body rather than only the preview",
    );
    const mediaData = "a".repeat(200);
    const mediaMessage = await first.applyToSupplementalMessage({
      role: "user",
      content: [{ type: "image", source: "base64", mimeType: "image/png", data: mediaData }],
    }, "call-host-media", { turnId: "turn-host-owned" });
    const mediaReference = mediaMessage.content.find((block) => block.type === "media_reference");
    assert.ok(mediaReference);
    assert.equal(
      new TextDecoder().decode(payloads.get(basename(mediaReference.path))),
      mediaData,
      "the same host store owns oversized media payloads",
    );

    await rm(join(projectRoot, ".pilotdeck", "tool-results"), { recursive: true, force: true });
    const restarted = new ToolResultBudget({
      toolResultsDir: storage.toolResultsDir,
      artifactStorage: payloadStore,
      maxResultSizeChars: 64,
      maxResultSizeTokens: 20,
      previewBytes: 32,
    });
    await restarted.hydrateReferences([message, mediaMessage]);

    assert.equal(await readFile(reference.path, "utf8"), original);
    assert.ok(reference.readFilePath);
    const restored = await createReadFileTool().execute(
      { file_path: reference.readFilePath, offset: 1, limit: 2 },
      context(projectRoot),
    );
    const text = restored.content[0]?.type === "text" ? restored.content[0].text : "";
    assert.match(text, /host-owned marker/);
    const materialized = await materializeMediaReferences([mediaMessage]);
    const restoredMedia = materialized.messages[0]?.content.find((block) => block.type === "image");
    assert.ok(restoredMedia);
    assert.equal(restoredMedia.data, mediaData);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
