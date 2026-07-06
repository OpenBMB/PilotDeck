import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import { WeComChannel } from "../../src/adapters/channel/wecom/WeComChannel.js";

type Frame = {
  cmd?: string;
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
};

class FakeWeComWebSocket extends EventEmitter {
  static instances: FakeWeComWebSocket[] = [];

  readyState = 0;
  sent: Frame[] = [];

  constructor(readonly url: string) {
    super();
    FakeWeComWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open");
    }, 0);
  }

  send(payload: string): void {
    const frame = JSON.parse(payload) as Frame;
    this.sent.push(frame);
    const reqId = frame.headers?.req_id;
    if (!reqId) return;

    let body: Record<string, unknown> = { errcode: 0 };
    if (frame.cmd === "aibot_upload_media_init") {
      body = { errcode: 0, upload_id: "upload-1" };
    } else if (frame.cmd === "aibot_upload_media_finish") {
      body = { errcode: 0, media_id: "media-1" };
    }

    setTimeout(() => {
      this.emit("message", JSON.stringify({ headers: { req_id: reqId }, body }));
    }, 0);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

test("WeCom deliverable MEDIA path uploads a markdown document and keeps the marker visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-wecom-media-"));
  try {
    const reportPath = join(dir, "report.md");
    await writeFile(reportPath, "# report\n", "utf8");
    const started = await startWeComHarness([
      { type: "assistant_text_delta", text: `报告已生成：MEDIA:${reportPath}` },
    ]);

    emitInboundText(started.ws, "请生成并发送报告", "msg-media");
    await waitFor(() => hasMediaResponse(started.ws, "file"), "file media response");

    const markdown = responseBodies(started.ws, "markdown").at(-1);
    assert.equal(markdownContent(markdown), `报告已生成：MEDIA:${reportPath}`);
    assert.equal(responseBodies(started.ws, "file").length, 1);
    assert.ok(started.gatewayInputs[0].message.includes("[WeCom attachment hint:"));

    await started.handle.stop("test done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WeCom deliverable bare local path uploads and keeps the visible path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-wecom-bare-"));
  try {
    const reportPath = join(dir, "report.md");
    await writeFile(reportPath, "# report\n", "utf8");
    const started = await startWeComHarness([
      { type: "assistant_text_delta", text: `文件已准备好：${reportPath}` },
    ]);

    emitInboundText(started.ws, "发送文档", "msg-bare");
    await waitFor(() => hasMediaResponse(started.ws, "file"), "bare path media response");

    const markdown = responseBodies(started.ws, "markdown").at(-1);
    assert.equal(markdownContent(markdown), `文件已准备好：${reportPath}`);
    assert.equal(uploadFrames(started.ws).length > 0, true);

    await started.handle.stop("test done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WeCom deliverable extraction ignores inline code and fenced code block paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-wecom-code-"));
  try {
    const reportPath = join(dir, "report.md");
    await writeFile(reportPath, "# report\n", "utf8");
    const started = await startWeComHarness([
      {
        type: "assistant_text_delta",
        text: [
          `不要发送 \`${reportPath}\`。`,
          "```",
          `MEDIA:${reportPath}`,
          "```",
        ].join("\n"),
      },
    ]);

    emitInboundText(started.ws, "展示示例", "msg-code");
    await waitFor(() => responseBodies(started.ws, "markdown").length > 0, "markdown response");
    await sleep(25);

    assert.equal(uploadFrames(started.ws).length, 0);
    const markdown = responseBodies(started.ws, "markdown").at(-1);
    const content = markdownContent(markdown);
    assert.ok(content?.includes(reportPath));

    await started.handle.stop("test done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WeCom deliverable extraction rejects sensitive paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-wecom-sensitive-"));
  try {
    const gitDir = join(dir, ".git");
    await mkdir(gitDir);
    const reportPath = join(gitDir, "report.md");
    await writeFile(reportPath, "# secret\n", "utf8");
    const started = await startWeComHarness([
      { type: "assistant_text_delta", text: `MEDIA:${reportPath}` },
    ]);

    emitInboundText(started.ws, "发送敏感路径", "msg-sensitive");
    await waitFor(() => responseBodies(started.ws, "markdown").length > 0, "sensitive warning");
    await sleep(25);

    assert.equal(uploadFrames(started.ws).length, 0);
    const markdown = responseBodies(started.ws, "markdown").at(-1);
    const content = markdownContent(markdown);
    assert.ok(content?.includes("附件未发送"));
    assert.ok(content?.includes(reportPath));

    await started.handle.stop("test done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WeCom tool_call_finished resultPath alone does not trigger deliverable upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-wecom-resultpath-"));
  try {
    const reportPath = join(dir, "report.md");
    await writeFile(reportPath, "# report\n", "utf8");
    const started = await startWeComHarness([
      {
        type: "tool_call_finished",
        toolCallId: "tool-1",
        toolName: "write_file",
        ok: true,
        resultPath: reportPath,
      },
      { type: "assistant_text_delta", text: "文件已生成。" },
    ]);

    emitInboundText(started.ws, "生成文件", "msg-resultpath");
    await waitFor(() => responseBodies(started.ws, "markdown").length > 0, "resultPath markdown");
    await sleep(25);

    assert.equal(uploadFrames(started.ws).length, 0);
    const markdown = responseBodies(started.ws, "markdown").at(-1);
    assert.equal(markdownContent(markdown), "文件已生成。");

    await started.handle.stop("test done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function startWeComHarness(events: GatewayEvent[]) {
  FakeWeComWebSocket.instances = [];
  const gatewayInputs: GatewaySubmitTurnInput[] = [];
  const gateway = {
    async *submitTurn(input: GatewaySubmitTurnInput) {
      gatewayInputs.push(input);
      for (const event of events) yield event;
    },
  } as unknown as Gateway;
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: {
      secret: "secret-1",
      dm_policy: "open",
      group_policy: "disabled",
      text_batch_delay_ms: 0,
    },
    webSocketCtor: FakeWeComWebSocket,
    uuid: stableUuid,
  });
  const handle = await channel.start({
    gateway,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
  const ws = FakeWeComWebSocket.instances.at(-1);
  assert.ok(ws);
  return { channel, gatewayInputs, handle, ws };
}

function emitInboundText(ws: FakeWeComWebSocket, text: string, messageId: string): void {
  ws.emit("message", JSON.stringify({
    cmd: "aibot_msg_callback",
    headers: { req_id: `reply-${messageId}` },
    body: {
      msgid: messageId,
      chatid: "chat-1",
      chattype: "single",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: text },
    },
  }));
}

function responseBodies(ws: FakeWeComWebSocket, msgtype: string): Record<string, unknown>[] {
  return ws.sent
    .filter((frame) => frame.cmd === "aibot_respond_msg" && frame.body?.msgtype === msgtype)
    .map((frame) => frame.body ?? {});
}

function uploadFrames(ws: FakeWeComWebSocket): Frame[] {
  return ws.sent.filter((frame) => String(frame.cmd ?? "").startsWith("aibot_upload_media_"));
}

function hasMediaResponse(ws: FakeWeComWebSocket, msgtype: string): boolean {
  return responseBodies(ws, msgtype).length > 0;
}

function markdownContent(body: Record<string, unknown> | undefined): string | undefined {
  const markdown = body?.markdown;
  return isRecord(markdown) ? String(markdown.content ?? "") : undefined;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableUuid(): string {
  return "00000000-0000-4000-8000-000000000001";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
