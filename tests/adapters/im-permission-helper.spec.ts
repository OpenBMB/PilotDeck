import test from "node:test";
import assert from "node:assert/strict";

import { ImPermissionHelper } from "../../src/adapters/channel/protocol/ImPermissionHelper.js";
import type { Gateway } from "../../src/gateway/index.js";

test("ImPermissionHelper resolves pending permission requests in FIFO order", async () => {
  const helper = new ImPermissionHelper();
  const decisions: Array<{
    sessionKey: string;
    requestId: string;
    decision: string;
    remember?: boolean;
  }> = [];
  const gateway = {
    permissionDecide: async (input: {
      sessionKey: string;
      requestId: string;
      decision: string;
      remember?: boolean;
    }) => {
      decisions.push(input);
      return { delivered: true };
    },
  } as unknown as Gateway;

  const first = helper.capture("chat-1", "session-1", {
    type: "permission_request",
    requestId: "request-1",
    toolName: "read_file",
    payload: { file_path: "/tmp/a.txt" },
  });
  const second = helper.capture("chat-1", "session-1", {
    type: "permission_request",
    requestId: "request-2",
    toolName: "read_file",
    payload: { file_path: "/tmp/b.txt" },
  });

  assert.match(first ?? "", /工具 read_file 需要权限/);
  assert.match(first ?? "", /\/tmp\/a\.txt/);
  assert.equal(second, undefined);
  assert.equal(helper.hasPending("chat-1"), true);

  const confirmation = await helper.answer("chat-1", "1", gateway);

  assert.equal(confirmation, "已允许一次，继续执行。");
  assert.deepEqual(decisions, [
    { sessionKey: "session-1", requestId: "request-1", decision: "allow", remember: false },
  ]);
  assert.equal(helper.hasPending("chat-1"), true);
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /\/tmp\/b\.txt/);
  helper.confirmNextPrompt("chat-1");
  assert.equal(await helper.answer("chat-1", "0", gateway), "已拒绝，继续处理。");
  assert.deepEqual(decisions, [
    { sessionKey: "session-1", requestId: "request-1", decision: "allow", remember: false },
    { sessionKey: "session-1", requestId: "request-2", decision: "deny", reason: "User denied permission from IM channel." },
  ]);
  assert.equal(helper.hasPending("chat-1"), false);
});

test("ImPermissionHelper keeps pending requests when the reply is invalid", async () => {
  const helper = new ImPermissionHelper();
  const gateway = {
    permissionDecide: async () => ({ delivered: true }),
  } as unknown as Gateway;

  helper.capture("chat-1", "session-1", {
    type: "permission_request",
    requestId: "request-1",
    toolName: "read_file",
    payload: { file_path: "/tmp/a.txt" },
  });

  const confirmation = await helper.answer("chat-1", "maybe", gateway);

  assert.equal(confirmation, "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。");
  assert.equal(helper.hasPending("chat-1"), true);
});

test("ImPermissionHelper ignores concurrent replies while a decision is in flight", async () => {
  const helper = new ImPermissionHelper();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const decisions: string[] = [];
  const gateway = {
    permissionDecide: async ({ requestId }: { requestId: string }) => {
      decisions.push(requestId);
      await gate;
      return { delivered: true };
    },
  } as unknown as Gateway;
  helper.capture("chat-1", "session-1", { type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {} });
  helper.capture("chat-1", "session-1", { type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {} });
  const first = helper.answer("chat-1", "1", gateway);
  assert.equal(helper.hasPending("chat-1"), true);
  assert.equal(await helper.answer("chat-1", "1", gateway), "权限决定处理中，请稍候。");
  release();
  assert.equal(await first, "已允许一次，继续执行。");
  assert.deepEqual(decisions, ["request-1"]);
  assert.equal(await helper.answer("chat-1", "1", gateway), undefined);
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /write_file/);
  helper.confirmNextPrompt("chat-1");
});

test("ImPermissionHelper does not let a duplicate reply consume the answering lock", async () => {
  const helper = new ImPermissionHelper();
  const decisions: string[] = [];
  const gateway = {
    permissionDecide: async ({ requestId }: { requestId: string }) => {
      decisions.push(requestId);
      return { delivered: true };
    },
  } as unknown as Gateway;

  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
  assert.equal(await helper.answer("chat-1", "1", gateway), undefined);
  assert.equal(await helper.answer("chat-1", "1", gateway), undefined);
  assert.deepEqual(decisions, ["request-1"]);

  assert.match(helper.takeNextPrompt("chat-1") ?? "", /write_file/);
  helper.confirmNextPrompt("chat-1");
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
  assert.deepEqual(decisions, ["request-1", "request-2"]);
});

test("ImPermissionHelper can recover when an adapter cannot deliver confirmation", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
  assert.equal(helper.isAnswering("chat-1"), true);
  helper.releaseAnswer("chat-1");
  assert.equal(helper.isAnswering("chat-1"), true);
  assert.equal(await helper.answer("chat-1", "1", gateway), "上一条权限提示发送失败，正在重试。");
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /write_file/);
  helper.confirmNextPrompt("chat-1");
  assert.equal(helper.isAnswering("chat-1"), false);
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
});

test("ImPermissionHelper does not resurrect a prompt after clear", async () => {
  const helper = new ImPermissionHelper();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gateway = {
    permissionDecide: async () => {
      await gate;
      return { delivered: true };
    },
  } as unknown as Gateway;
  helper.capture("chat-1", "old-session", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  const answer = helper.answer("chat-1", "1", gateway);
  helper.clear("chat-1");
  release();
  assert.equal(await answer, undefined);
  assert.equal(helper.takeNextPrompt("chat-1"), undefined);
  assert.equal(helper.hasPending("chat-1"), false);
  assert.equal((helper as any).generations.size, 0);
});

test("ImPermissionHelper releases generation state after a completed answer", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  await helper.answer("chat-1", "1", gateway);
  assert.equal((helper as any).generations.size, 0);
});

test("ImPermissionHelper restores the current request when permissionDecide fails", async () => {
  const helper = new ImPermissionHelper();
  let attempts = 0;
  const gateway = {
    permissionDecide: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gateway unavailable");
      return { delivered: true };
    },
  } as unknown as Gateway;

  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  await assert.rejects(helper.answer("chat-1", "1", gateway), /gateway unavailable/);
  assert.equal(helper.hasPending("chat-1"), true);
  assert.equal(helper.isAnswering("chat-1"), false);
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
  assert.equal(attempts, 2);
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /write_file/);
});

test("ImPermissionHelper queues permission requests captured during a decision", async () => {
  const helper = new ImPermissionHelper();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gateway = {
    permissionDecide: async () => {
      await gate;
      return { delivered: true };
    },
  } as unknown as Gateway;

  assert.match(helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  }) ?? "", /read_file/);
  const answer = helper.answer("chat-1", "1", gateway);
  assert.equal(helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  }), undefined);
  release();
  assert.equal(await answer, "已允许一次，继续执行。");
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /write_file/);
});

test("ImPermissionHelper keeps new state intact when an old answer finishes after clear", async () => {
  const helper = new ImPermissionHelper();
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const decisions: string[] = [];
  const gateway = {
    permissionDecide: async ({ requestId }: { requestId: string }) => {
      decisions.push(requestId);
      if (requestId === "old-request") await oldGate;
      return { delivered: true };
    },
  } as unknown as Gateway;

  helper.capture("chat-1", "old-session", {
    type: "permission_request", requestId: "old-request", toolName: "read_file", payload: {},
  });
  const oldAnswer = helper.answer("chat-1", "1", gateway);
  helper.clear("chat-1");
  helper.capture("chat-1", "new-session", {
    type: "permission_request", requestId: "new-request", toolName: "write_file", payload: {},
  });
  const newAnswer = helper.answer("chat-1", "1", gateway);

  assert.equal(await newAnswer, "已允许一次，继续执行。");
  assert.equal(helper.hasPending("chat-1"), false);
  releaseOld();
  assert.equal(await oldAnswer, undefined);
  assert.deepEqual(decisions, ["old-request", "new-request"]);
  assert.equal(helper.isAnswering("chat-1"), false);
  assert.equal((helper as any).generations.size, 0);
});
