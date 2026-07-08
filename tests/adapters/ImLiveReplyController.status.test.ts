import assert from "node:assert/strict";
import test from "node:test";

import { ImLiveReplyController } from "../../src/adapters/channel/protocol/ImLiveReplyController.js";
import type { GatewayEvent } from "../../src/gateway/index.js";

function createSentTextTransport() {
  const sent: string[] = [];
  return {
    sent,
    transport: {
      async send(text: string): Promise<string> {
        sent.push(text);
        return `handle-${sent.length}`;
      },
    },
  };
}

test("IM live reply emits warning text for new semantic status and dedupes generic error", async () => {
  const { sent, transport } = createSentTextTransport();
  const controller = new ImLiveReplyController<string>({ transport, turnTimeoutMs: 0 });

  await controller.handleEvent({ type: "turn_started", runId: "turn-1" });
  await controller.handleEvent({
    type: "agent_status",
    event: "model_request_failed",
    detail: {
      message: "Provider rejected the request.",
      visible: true,
      userHint: "Check provider settings.",
    },
  });
  await controller.handleEvent({
    type: "error",
    code: "agent_model_error",
    message: "Generic turn_failed copy.",
    recoverable: false,
  });
  await controller.flushFinal();

  assert.deepEqual(sent, ["\n⚠️ Provider rejected the request.\n"]);
});

test("IM live reply keeps tool call errors on the tool result path", async () => {
  const { sent, transport } = createSentTextTransport();
  const controller = new ImLiveReplyController<string>({
    transport,
    turnTimeoutMs: 0,
    formatToolError(event: GatewayEvent & { type: "tool_call_finished"; ok: false }) {
      return `\nTOOL:${event.errorCode}:${event.resultPreview}\n`;
    },
  });

  await controller.handleEvent({
    type: "tool_call_finished",
    toolCallId: "tool-1",
    ok: false,
    toolName: "read_file",
    errorCode: "file_not_found",
    resultPreview: "missing",
  });
  await controller.flushFinal();

  assert.deepEqual(sent, ["\nTOOL:file_not_found:missing\n"]);
});

test("IM live reply emits warning text for channel submit status", async () => {
  const { sent, transport } = createSentTextTransport();
  const controller = new ImLiveReplyController<string>({ transport, turnTimeoutMs: 0 });

  await controller.handleEvent({
    type: "agent_status",
    event: "channel_submit_failed",
    detail: {
      message: "处理消息时发生错误，请重试。",
      code: "channel_submit_failed",
      severity: "error",
      visible: true,
      userHint: "Retry later.",
      scope: "channel",
      source: "im_channel",
    },
  });
  await controller.flushFinal();

  assert.deepEqual(sent, ["\n⚠️ 处理消息时发生错误，请重试。\n"]);
});
