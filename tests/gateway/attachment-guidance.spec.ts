import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("registered plain-text attachments with non-whitelisted names are described as read_file inspectable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-guidance-"));
  try {
    const dockerfilePath = join(root, "Dockerfile");
    await writeFile(dockerfilePath, "FROM node:22\n");

    let capturedInput: AgentInput | undefined;
    const gateway = createGateway((input) => {
      capturedInput = input;
    });

    for await (const _event of gateway.submitTurn({
      sessionKey: "session-1",
      channelKey: "feishu",
      message: "inspect attachment",
      attachments: [{
        type: "file",
        path: dockerfilePath,
        name: "Dockerfile",
        metadata: { channelKey: "feishu" },
      }],
    })) {
      // Drain the stream so the fake session runs to completion.
    }

    const text = inputText(capturedInput);
    assert.match(text, /Dockerfile/);
    assert.match(text, /Use read_file with the exact path/);
    assert.doesNotMatch(text, /not directly inspectable with read_file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploaded text uses its original name when its staged path has no extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-guidance-"));
  try {
    const stagedPath = join(root, "file-0-opaque-upload-id");
    await writeFile(stagedPath, "心理学科百年纪念会材料");

    let capturedInput: AgentInput | undefined;
    const gateway = createGateway((input) => {
      capturedInput = input;
    });

    for await (const _event of gateway.submitTurn({
      sessionKey: "session-1",
      channelKey: "feishu",
      message: "根据附件起草讲话稿",
      attachments: [{
        type: "file",
        path: stagedPath,
        name: "心理学科百年材料.md",
        metadata: { channelKey: "feishu" },
      }],
    })) {
      // Drain the stream so the fake session runs to completion.
    }

    const text = inputText(capturedInput);
    assert.match(text, /心理学科百年纪念会材料/);
    assert.doesNotMatch(text, /File extension \(none\) is not in the inline text whitelist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered Office attachments receive conversion guidance without raw diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-guidance-"));
  try {
    const docxPath = join(root, "sample.docx");
    await writeFile(docxPath, Buffer.from("PK".padEnd(128, "x")));

    let capturedInput: AgentInput | undefined;
    const gateway = createGateway((input) => {
      capturedInput = input;
    });

    for await (const _event of gateway.submitTurn({
      sessionKey: "session-1",
      channelKey: "feishu",
      message: "inspect attachment",
      attachments: [{
        type: "file",
        path: docxPath,
        name: "sample.docx",
        metadata: { channelKey: "feishu" },
      }],
    })) {
      // Drain the stream so the fake session runs to completion.
    }

    const text = inputText(capturedInput);
    assert.match(text, /sample\.docx/);
    assert.match(text, /not directly inspectable with read_file/);
    assert.doesNotMatch(text, /\[Attachment diagnostics\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered audio attachments advertise FunASR paths instead of read_file conversion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-guidance-"));
  try {
    const audioPath = join(root, "meeting.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));

    let capturedInput: AgentInput | undefined;
    const gateway = createGateway((input) => {
      capturedInput = input;
    });

    for await (const _event of gateway.submitTurn({
      sessionKey: "session-1",
      channelKey: "feishu",
      projectKey: root,
      message: "please transcribe this recording",
      attachments: [{
        type: "file",
        path: audioPath,
        name: "meeting.wav",
        mimeType: "audio/wav",
        metadata: { channelKey: "feishu" },
      }],
    })) {
      // Drain the stream so the fake session runs to completion.
    }

    const text = inputText(capturedInput);
    assert.match(text, /meeting\.wav/);
    assert.match(text, /transcribe_audio/);
    assert.match(text, new RegExp(audioPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /retry the tool in this session/);
    assert.match(text, /npm --prefix/);
    assert.doesNotMatch(text, /not directly inspectable with read_file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createGateway(onInput: (input: AgentInput) => void): InProcessGateway {
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => createFakeSession(onInput),
  });
  return new InProcessGateway(router, {
    uuid: () => "run-1",
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });
}

function createFakeSession(onInput: (input: AgentInput) => void): AgentSession {
  return {
    async *submit(input: AgentInput, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn-1";
      onInput(input);
      yield { type: "turn_started", sessionId: "session-1", turnId };
      yield {
        type: "turn_completed",
        sessionId: "session-1",
        turnId,
        result: {
          type: "success",
          sessionId: "session-1",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-07-20T00:00:00.000Z",
          completedAt: "2026-07-20T00:00:00.000Z",
        },
      };
    },
    abort() {},
    snapshot() {
      return {
        sessionId: "session-1",
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
      };
    },
  } as unknown as AgentSession;
}

function inputText(input: AgentInput | undefined): string {
  assert.ok(input, "expected fake session to receive agent input");
  if (input.type === "text") return input.text;
  return input.content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}
