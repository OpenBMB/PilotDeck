import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { FeishuChannel } from "../../src/adapters/index.js";
import type { Gateway } from "../../src/gateway/index.js";

test("Feishu handles permission replies before the active chat drain finishes", async () => {
  const chatId = "oc_test";
  const decisions: Array<{
    sessionKey: string;
    requestId: string;
    decision: string;
    remember?: boolean;
  }> = [];
  let resolveDecided!: () => void;
  const decided = new Promise<void>((resolve) => {
    resolveDecided = resolve;
  });
  const gateway = {
    permissionDecide: async (input: {
      sessionKey: string;
      requestId: string;
      decision: string;
      remember?: boolean;
    }) => {
      decisions.push(input);
      resolveDecided();
      return { delivered: true };
    },
  } as unknown as Gateway;
  const sent: Array<{ chatId: string; text: string }> = [];
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => {
      sent.push(message);
    },
  });
  await channel.start({ gateway, logger: {} });

  (channel as any).permissions.capture(chatId, "session-1", {
    type: "permission_request",
    requestId: "request-1",
    toolName: "read_file",
    payload: { file_path: "/tmp/a.txt" },
  });
  (channel as any).permissions.confirmInitialPrompt(chatId);
  await delay(10);
  (channel as any).inboundBatches.set(chatId, { messages: [], draining: true });

  const response = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-1" }),
  );
  await withTimeout(decided, 1_000);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(decisions, [
    { sessionKey: "session-1", requestId: "request-1", decision: "allow", remember: false },
  ]);
  assert.deepEqual(sent, [{ chatId, text: "已允许一次，继续执行。" }]);
  assert.deepEqual((channel as any).inboundBatches.get(chatId), { messages: [], draining: true });
});

test("Feishu sends permission prompts in FIFO order", async () => {
  const chatId = "oc_batch";
  const sent: Array<{ chatId: string; text: string }> = [];
  const decisions: string[] = [];
  let releaseTurn!: () => void;
  const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const gateway = {
    submitTurn: async function* () {
      yield { type: "turn_started", runId: "run-batch" };
      yield {
        type: "permission_request",
        requestId: "request-1",
        toolName: "read_file",
        payload: { file_path: "/tmp/a.txt" },
      };
      yield {
        type: "permission_request",
        requestId: "request-2",
        toolName: "glob",
        payload: { pattern: "**/*.pptx" },
      };
      await turnReleased;
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
    permissionDecide: async (input: { requestId: string }) => {
      decisions.push(input.requestId);
      if (decisions.length === 2) releaseTurn();
      return { delivered: true };
    },
  } as unknown as Gateway;
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => { sent.push(message); },
  });
  await channel.start({ gateway, logger: {} });

  const response = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "run", eventId: "run-1" }),
  );
  await delay(50);

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? "", /工具 read_file 需要权限/);

  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-1" }),
  );
  await delay(50);
  assert.deepEqual(decisions, ["request-1"]);
  assert.equal(sent.length, 3);
  assert.match(sent[2]?.text ?? "", /工具 glob 需要权限/);

  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-2" }),
  );
  await delay(50);
  assert.deepEqual(decisions, ["request-1", "request-2"]);
});

test("Feishu does not decide replies before the initial permission prompt is confirmed", async () => {
  const chatId = "oc_duplicate_reply";
  const sent: Array<{ chatId: string; text: string }> = [];
  const decisions: string[] = [];
  let releaseDecision!: () => void;
  const decisionGate = new Promise<void>((resolve) => { releaseDecision = resolve; });
  let resolvePermissionShown!: () => void;
  const permissionShown = new Promise<void>((resolve) => { resolvePermissionShown = resolve; });
  let turnCount = 0;
  const gateway = {
    submitTurn: async function* () {
      turnCount += 1;
      yield { type: "turn_started", runId: `run-${turnCount}` };
      resolvePermissionShown();
      yield {
        type: "permission_request",
        requestId: "request-duplicate",
        toolName: "bash",
        payload: { command: "ls -l /tmp" },
      };
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
    permissionDecide: async (input: { requestId: string }) => {
      decisions.push(input.requestId);
      await decisionGate;
      return { delivered: true };
    },
  } as unknown as Gateway;
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => { sent.push(message); },
  });
  await channel.start({ gateway, logger: {} });

  const response = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "run", eventId: "run-duplicate" }),
  );
  await withTimeout(permissionShown, 1_000);
  while (!sent.some((message) => message.text.includes("工具 bash 需要权限"))) await delay(5);
  (channel as any).permissions.confirmInitialPrompt(chatId);
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-duplicate-1" }),
  );
  await delay(20);
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-duplicate-2" }),
  );
  await delay(20);
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-duplicate-3" }),
  );
  await delay(50);

  assert.deepEqual(decisions, []);
  assert.ok(turnCount >= 1);
  assert.equal(sent.filter((message) => message.text.includes("已允许一次")).length, 0);
});

test("Feishu keeps the next permission locked when confirmation delivery fails", async () => {
  const chatId = "oc_send_failure";
  const sent: Array<{ chatId: string; text: string }> = [];
  const decisions: string[] = [];
  let sendCount = 0;
  const gateway = {
    permissionDecide: async ({ requestId }: { requestId: string }) => {
      decisions.push(requestId);
      return { delivered: true };
    },
  } as unknown as Gateway;
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => {
      sendCount += 1;
      if (sendCount === 1) throw new Error("send unavailable");
      sent.push(message);
    },
  });
  await channel.start({ gateway, logger: {} });

  (channel as any).permissions.capture(chatId, "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  (channel as any).permissions.confirmInitialPrompt(chatId);
  (channel as any).permissions.capture(chatId, "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  const response = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-send-failure-1" }),
  );
  await delay(20);
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-send-failure-2" }),
  );
  await delay(20);

  assert.deepEqual(decisions, ["request-1"]);
  assert.match(sent.find((message) => message.text.includes("工具 write_file 需要权限"))?.text ?? "", /write_file/);
});

test("Feishu reports explicit sender failures as undelivered", async () => {
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async () => {
      throw new Error("send unavailable");
    },
  });

  assert.equal(await (channel as any).send({ chatId: "oc_send_failure", text: "permission prompt" }), false);
});

function createMockResponse(): { statusCode?: number; body?: string; writeHead(statusCode: number): void; end(body: string): void } {
  return {
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for permission decision")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}
