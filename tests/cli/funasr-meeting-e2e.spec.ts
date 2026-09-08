import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { GatewayEvent } from "../../src/gateway/index.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "../../src/model/protocol/canonical.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { MultimodalConstraints } from "../../src/model/protocol/multimodal.js";

const runRealE2e = process.env.PILOTDECK_RUN_FUNASR_E2E === "1";
const pilotHome = process.env.PILOTDECK_FUNASR_E2E_PILOT_HOME;
const skipReason = !runRealE2e
  ? "set PILOTDECK_RUN_FUNASR_E2E=1 after installing the local FunASR runtime"
  : !pilotHome
    ? "set PILOTDECK_FUNASR_E2E_PILOT_HOME to the isolated PILOT_HOME used by npm run install:asr"
    : false;

test("real FunASR with a scripted Agent turns an audio attachment into a local knowledge-base meeting note", { skip: skipReason }, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-funasr-meeting-"));
  const gatewayPilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-funasr-gateway-home-"));
  const audioPath = join(projectRoot, "meeting.wav");
  const knowledgeBasePath = join(projectRoot, "knowledge-bases", "项目知识库.md");
  const fixturePath = join(process.cwd(), "tests", "fixtures", "funasr", "meeting.wav");
  await copyFile(fixturePath, audioPath);
  await symlink(
    join(resolve(pilotHome!), "funasr"),
    join(gatewayPilotHome, "funasr"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(join(gatewayPilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const model = new MeetingNoteModel(knowledgeBasePath);
  const local = createLocalGateway({
    projectRoot,
    pilotHome: gatewayPilotHome,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const events: GatewayEvent[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "funasr-meeting-e2e",
      channelKey: "test",
      projectKey: projectRoot,
      message: "将这份音频文件整理形成纪要，并放入项目知识库中。",
      mode: "bypassPermissions",
      basePermissionMode: "bypassPermissions",
      attachments: [{
        type: "file",
        name: "meeting.wav",
        path: audioPath,
        mimeType: "audio/wav",
        metadata: { channelKey: "test" },
      }],
      timeoutMs: 300_000,
    })) {
      events.push(event);
    }

    const startedTools = events
      .filter((event): event is Extract<GatewayEvent, { type: "tool_call_started" }> => event.type === "tool_call_started")
      .map((event) => event.name);
    assert.deepEqual(startedTools, ["mcp__funasr__transcribe_audio", "write_file"]);
    assert.equal(model.transcribePath, audioPath);
    assert.equal(model.transcribeLanguage, "auto");
    assert.match(model.transcript, /Timestamped segments/u);
    assert.match(model.transcript, /项目/u);

    const note = await readFile(knowledgeBasePath, "utf8");
    assert.match(note, /^# 项目进度会议纪要/mu);
    assert.match(note, /## 转写内容/u);
    assert.match(note, /## 概括总结/u);
    assert.match(note, /## 行动项/u);
    assert.match(note, /Timestamped segments/u);
    assert.match(note, /周五前提交测试报告/u);

    const reply = events
      .filter((event): event is Extract<GatewayEvent, { type: "assistant_text_delta" }> => event.type === "assistant_text_delta")
      .map((event) => event.text)
      .join("");
    assert.match(reply, /转写内容/u);
    assert.match(reply, /概括总结/u);
    assert.match(reply, /knowledge-bases\/项目知识库\.md/u);
  } finally {
    local.dispose();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(gatewayPilotHome, { recursive: true, force: true });
  }
});

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
`;

class MeetingNoteModel implements ModelRuntime {
  transcript = "";
  transcribePath = "";
  transcribeLanguage = "";

  constructor(private readonly knowledgeBasePath: string) {}

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };

    const toolResult = findToolResult(request.messages, "asr-call");
    if (!toolResult) {
      yield* this.toolCall("asr-call", "mcp__funasr__transcribe_audio", {
        audio_path: this.attachmentPath(request.messages),
        language: "auto",
      });
      return;
    }

    this.transcript = toolResult;
    const writeResult = findToolResult(request.messages, "write-note");
    if (!writeResult) {
      yield* this.toolCall("write-note", "write_file", {
        file_path: this.knowledgeBasePath,
        content: this.meetingNote(toolResult),
      });
      return;
    }

    yield {
      type: "text_delta",
      text: `转写内容和概括总结已整理，并写入 knowledge-bases/项目知识库.md。\n\n概括总结：前端功能已完成；小王需在周五前提交测试报告。`,
    };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "" }], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }

  private async *toolCall(id: string, name: string, input: Record<string, unknown>): AsyncIterable<CanonicalModelEvent> {
    if (name === "mcp__funasr__transcribe_audio") {
      this.transcribePath = String(input.audio_path);
      this.transcribeLanguage = String(input.language);
    }
    yield { type: "tool_call_start", id, name };
    yield { type: "tool_call_end", toolCall: { id, name, input } };
    yield { type: "message_end", finishReason: "tool_call" };
  }

  private attachmentPath(messages: CanonicalMessage[]): string {
    const text = messages.flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const match = /- meeting\.wav: ([^\n]+)/u.exec(text);
    assert.ok(match, "expected registered meeting.wav path in agent input");
    return match[1]!.trim();
  }

  private meetingNote(transcript: string): string {
    return [
      "# 项目进度会议纪要",
      "",
      "## 转写内容",
      transcript,
      "",
      "## 概括总结",
      "- 前端功能已经完成。",
      "- 本周重点是补齐测试验证。",
      "",
      "## 行动项",
      "- 小王：周五前提交测试报告。",
      "",
    ].join("\n");
  }
}

function findToolResult(messages: CanonicalMessage[], toolCallId: string): string | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.toolCallId !== toolCallId) continue;
      return block.content
        .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
        .map((content) => content.text)
        .join("\n");
    }
  }
  return undefined;
}
