import assert from "node:assert/strict";
import test from "node:test";

import { renderBlueBubblesEvent } from "../../src/adapters/channel/bluebubbles/bluebubbles-render.js";
import { renderDingTalkEvent } from "../../src/adapters/channel/dingtalk/dingtalk-render.js";
import { renderDiscordEvent } from "../../src/adapters/channel/discord/discord-render.js";
import { renderEmailEvent } from "../../src/adapters/channel/email/email-render.js";
import { renderFeishuEvent } from "../../src/adapters/channel/feishu/feishu-render.js";
import { renderHomeAssistantEvent } from "../../src/adapters/channel/homeassistant/homeassistant-render.js";
import { renderMatrixEvent } from "../../src/adapters/channel/matrix/matrix-render.js";
import { renderMattermostEvent } from "../../src/adapters/channel/mattermost/mattermost-render.js";
import { renderQQEvent } from "../../src/adapters/channel/qq/qq-render.js";
import { renderSignalEvent } from "../../src/adapters/channel/signal/signal-render.js";
import { renderSlackEvent } from "../../src/adapters/channel/slack/slack-render.js";
import { renderSmsEvent } from "../../src/adapters/channel/sms/sms-render.js";
import { renderTelegramEvent } from "../../src/adapters/channel/telegram/telegram-render.js";
import { renderWeComCallbackEvent } from "../../src/adapters/channel/wecom-callback/wecom-callback-render.js";
import { renderWeComEvent } from "../../src/adapters/channel/wecom/wecom-render.js";
import { renderWeixinEvent } from "../../src/adapters/channel/weixin/weixin-render.js";
import { renderWhatsAppEvent } from "../../src/adapters/channel/whatsapp/whatsapp-render.js";
import type { GatewayEvent } from "../../src/gateway/index.js";

type Renderer = (event: GatewayEvent) => string | undefined;

const RENDERERS: Array<[string, Renderer]> = [
  ["bluebubbles", renderBlueBubblesEvent],
  ["dingtalk", renderDingTalkEvent],
  ["discord", renderDiscordEvent],
  ["email", renderEmailEvent],
  ["feishu", renderFeishuEvent],
  ["homeassistant", renderHomeAssistantEvent],
  ["matrix", renderMatrixEvent],
  ["mattermost", renderMattermostEvent],
  ["qq", renderQQEvent],
  ["signal", renderSignalEvent],
  ["slack", renderSlackEvent],
  ["sms", renderSmsEvent],
  ["telegram", renderTelegramEvent],
  ["wecom-callback", renderWeComCallbackEvent],
  ["wecom", renderWeComEvent],
  ["weixin", renderWeixinEvent],
  ["whatsapp", renderWhatsAppEvent],
];

const TOOL_STARTED: GatewayEvent = {
  type: "tool_call_started",
  toolCallId: "tool-1",
  name: "read_file",
};
const TOOL_SUCCEEDED: GatewayEvent = {
  type: "tool_call_finished",
  toolCallId: "tool-1",
  toolName: "read_file",
  ok: true,
};
const TOOL_FAILED: GatewayEvent = {
  type: "tool_call_finished",
  toolCallId: "tool-1",
  toolName: "read_file",
  ok: false,
};
const ELICITATION: GatewayEvent = {
  type: "elicitation_request",
  requestId: "request-1",
  toolCallId: "tool-2",
  toolName: "ask_user_question",
  questions: [{
    header: "Choice",
    question: "Continue?",
    options: [
      { label: "Yes", description: "Proceed" },
      { label: "No", description: "Stop" },
    ],
  }],
};

test("IM renderers suppress tool start and successful tool completion noise", () => {
  for (const [channel, render] of RENDERERS) {
    assert.equal(render(TOOL_STARTED), "", `${channel} tool start`);
    assert.equal(render(TOOL_SUCCEEDED), "", `${channel} tool success`);
  }
});

test("IM renderers retain failed tool calls as visible failures", () => {
  for (const [channel, render] of RENDERERS) {
    const rendered = render(TOOL_FAILED);
    assert.match(rendered ?? "", /read_file/, channel);
    assert.notEqual(rendered, "", channel);
  }
});

test("IM renderers preserve assistant text and render elicitation choices", () => {
  for (const [channel, render] of RENDERERS) {
    assert.equal(render({ type: "assistant_text_delta", text: "answer" }), "answer", channel);
    const rendered = render(ELICITATION);
    assert.match(rendered ?? "", /\*\*Choice\*\*/, channel);
    assert.match(rendered ?? "", /Continue\?/, channel);
    assert.match(rendered ?? "", /1\. Yes/, channel);
    assert.match(rendered ?? "", /2\. No/, channel);
  }
});
