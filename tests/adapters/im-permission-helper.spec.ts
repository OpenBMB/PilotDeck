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
  helper.confirmInitialPrompt("chat-1");

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
  assert.equal(helper.takeNextPrompt("chat-1"), undefined);
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
  helper.confirmInitialPrompt("chat-1");

  const confirmation = await helper.answer("chat-1", "maybe", gateway);

  assert.equal(confirmation, "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。");
  assert.equal(helper.hasPending("chat-1"), true);
});

test("ImPermissionHelper retries an undelivered initial prompt before accepting a reply", async () => {
  const helper = new ImPermissionHelper();
  const decisions: string[] = [];
  const gateway = {
    permissionDecide: async ({ requestId }: { requestId: string }) => {
      decisions.push(requestId);
      return { delivered: true };
    },
  } as unknown as Gateway;

  const prompt = helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  assert.match(prompt ?? "", /read_file/);
  assert.equal(await helper.answer("chat-1", "1", gateway), "权限提示发送中，请稍候。");
  helper.confirmInitialPrompt("chat-1", false);
  assert.equal(await helper.answer("chat-1", "1", gateway), "上一条权限提示发送失败，正在重试。");
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /read_file/);
  helper.confirmNextPrompt("chat-1", true);
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
  assert.deepEqual(decisions, ["request-1"]);
});

test("ImPermissionHelper does not advance on status replies during prompt delivery", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });

  assert.equal(await helper.answer("chat-1", "1", gateway), "权限提示发送中，请稍候。");
  assert.equal(helper.takeNextPrompt("chat-1"), undefined);
  assert.equal(helper.isAnswering("chat-1"), true);
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
  helper.confirmInitialPrompt("chat-1");
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

test("ImPermissionHelper marks an in-flight status reply as non-advancing after completion", async () => {
  const helper = new ImPermissionHelper();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gateway = {
    permissionDecide: async () => {
      await gate;
      return { delivered: true };
    },
  } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  const first = helper.answerWithState("chat-1", "1", gateway);
  const duplicate = await helper.answerWithState("chat-1", "1", gateway);
  assert.equal(duplicate?.canAdvance, false);
  release();
  assert.equal((await first)?.canAdvance, true);
  assert.equal(duplicate?.text, "权限决定处理中，请稍候。");
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
  helper.confirmInitialPrompt("chat-1");
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");

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
  helper.confirmInitialPrompt("chat-1");
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

test("ImPermissionHelper ignores stale prompt delivery callbacks after chat reuse", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;

  const oldPrompt = helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "old", toolName: "read_file", payload: { path: "old" },
  });
  assert.ok(oldPrompt);
  helper.clear("chat-1");

  const newPrompt = helper.capture("chat-1", "session-2", {
    type: "permission_request", requestId: "new", toolName: "write_file", payload: { path: "new" },
  });
  assert.ok(newPrompt);
  helper.confirmInitialPrompt("chat-1", true, "old");
  assert.equal(helper.isAnswering("chat-1"), true);
  assert.equal(await helper.answer("chat-1", "1", gateway), "权限提示发送中，请稍候。");
  helper.confirmInitialPrompt("chat-1", true, "new");
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
});

test("ImPermissionHelper uses requestId when identical prompts are reused", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  const oldPrompt = helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "old-request", toolName: "read_file", payload: { path: "/tmp/same" },
  });
  helper.clear("chat-1");
  const newPrompt = helper.capture("chat-1", "session-2", {
    type: "permission_request", requestId: "new-request", toolName: "read_file", payload: { path: "/tmp/same" },
  });
  assert.equal(oldPrompt, newPrompt);

  helper.confirmInitialPrompt("chat-1", true, "old-request");
  assert.equal(helper.isAnswering("chat-1"), true);
  assert.equal(await helper.answer("chat-1", "1", gateway), "权限提示发送中，请稍候。");
  helper.confirmInitialPrompt("chat-1", true, "new-request");
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
});

test("ImPermissionHelper ignores stale next-prompt callbacks and answer releases", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;

  const first = helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "first", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1", true, "first");
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "second", toolName: "write_file", payload: {},
  });
  const answer = await helper.answerWithState("chat-1", "1", gateway);
  assert.equal(answer?.canAdvance, true);
  const nextPrompt = helper.takeNextPrompt("chat-1");
  assert.ok(nextPrompt);
  helper.confirmNextPrompt("chat-1", true, "stale-request");
  assert.equal(helper.isAnswering("chat-1"), true);
  helper.clear("chat-1");

  const replacement = helper.capture("chat-1", "session-2", {
    type: "permission_request", requestId: "replacement", toolName: "exec", payload: {},
  });
  assert.ok(replacement);
  helper.confirmNextPrompt("chat-1", true, "second");
  helper.releaseAnswer("chat-1", answer?.answerToken);
  assert.equal(await helper.answer("chat-1", "1", gateway), "权限提示发送中，请稍候。");
  helper.confirmInitialPrompt("chat-1", true, "replacement");
  assert.equal(await helper.answer("chat-1", "1", gateway), "已允许一次，继续执行。");
});

test("ImPermissionHelper does not let an old release unlock a replacement decision", async () => {
  const helper = new ImPermissionHelper();
  let releaseNew!: () => void;
  const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
  let calls = 0;
  const gateway = {
    permissionDecide: async () => {
      calls += 1;
      if (calls === 2) await newGate;
      return { delivered: true };
    },
  } as unknown as Gateway;

  const oldPrompt = helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "old", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1", true, "old");
  const oldAnswer = await helper.answerWithState("chat-1", "1", gateway);
  helper.clear("chat-1");

  const newPrompt = helper.capture("chat-1", "session-2", {
    type: "permission_request", requestId: "new", toolName: "write_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1", true, "new");
  const newAnswer = helper.answerWithState("chat-1", "1", gateway);
  await new Promise((resolve) => setImmediate(resolve));
  helper.releaseAnswer("chat-1", oldAnswer?.answerToken);
  assert.equal(await helper.answerWithState("chat-1", "1", gateway).then((result) => result?.text), "权限决定处理中，请稍候。");
  releaseNew();
  assert.equal((await newAnswer)?.canAdvance, true);
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
  helper.confirmInitialPrompt("chat-1");
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
  helper.confirmInitialPrompt("chat-1");
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
  helper.confirmInitialPrompt("chat-1");
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

test("ImPermissionHelper drops stale requests when permissionDecide is not delivered", async () => {
  const helper = new ImPermissionHelper();
  const decisions: string[] = [];
  const gateway = {
    permissionDecide: async ({ requestId }: { requestId: string }) => {
      decisions.push(requestId);
      return { delivered: requestId !== "request-1" };
    },
  } as unknown as Gateway;

  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  const result = await helper.answerWithState("chat-1", "1", gateway);
  assert.equal(result?.canAdvance, false);
  assert.equal(result?.retryPrompt, true);
  assert.match(result?.text ?? "", /失效|跳过/);
  assert.equal(helper.isAnswering("chat-1"), true);

  const nextPrompt = helper.takeNextPrompt("chat-1");
  assert.match(nextPrompt ?? "", /write_file/);
  assert.doesNotMatch(nextPrompt ?? "", /read_file/);
  assert.deepEqual(decisions, ["request-1"]);
  helper.confirmNextPrompt("chat-1", true, "request-2");
  assert.equal(await helper.answerWithState("chat-1", "1", gateway).then((next) => next?.canAdvance), true);
  assert.deepEqual(decisions, ["request-1", "request-2"]);
  assert.equal(helper.takeNextPrompt("chat-1"), undefined);
});

test("ImPermissionHelper keeps the final answer locked until delivery is confirmed", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");

  const answer = await helper.answerWithState("chat-1", "1", gateway);
  assert.equal(answer?.canAdvance, true);
  assert.equal(helper.isAnswering("chat-1"), true);
  assert.equal(await helper.answerWithState("chat-1", "1", gateway), undefined);

  assert.equal(helper.takeNextPrompt("chat-1"), undefined);
  assert.equal(helper.isAnswering("chat-1"), false);
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
  helper.confirmInitialPrompt("chat-1");
  const answer = helper.answer("chat-1", "1", gateway);
  assert.equal(helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  }), undefined);
  release();
  assert.equal(await answer, "已允许一次，继续执行。");
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /write_file/);
});

test("ImPermissionHelper queues a request captured after the final decision RPC", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");

  const answer = await helper.answerWithState("chat-1", "1", gateway);
  assert.ok(answer?.answerToken);
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });

  assert.match(helper.takeNextPrompt("chat-1", answer.answerToken) ?? "", /write_file/);
  helper.confirmNextPrompt("chat-1", true, "request-2");
  assert.equal(helper.isAnswering("chat-1"), false);
});

test("ImPermissionHelper rejects stale answer tokens when taking a replacement prompt", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "old", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  const oldAnswer = await helper.answerWithState("chat-1", "1", gateway);
  helper.clear("chat-1");

  helper.capture("chat-1", "session-2", {
    type: "permission_request", requestId: "new", toolName: "write_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  helper.capture("chat-1", "session-2", {
    type: "permission_request", requestId: "new-next", toolName: "exec", payload: {},
  });
  const newAnswer = await helper.answerWithState("chat-1", "1", gateway);
  assert.notEqual(oldAnswer?.answerToken, newAnswer?.answerToken);

  assert.equal(helper.takeNextPrompt("chat-1", oldAnswer?.answerToken), undefined);
  assert.match(helper.takeNextPrompt("chat-1", newAnswer?.answerToken) ?? "", /exec/);
});

test("ImPermissionHelper defers turn cleanup until the answer is delivered", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  const answer = await helper.answerWithState("chat-1", "1", gateway);
  helper.clearAfterTurn("chat-1");

  assert.equal(helper.isAnswering("chat-1"), true);
  helper.confirmAnswer("chat-1", answer?.answerToken);
  assert.equal(helper.isAnswering("chat-1"), false);
  assert.equal(helper.hasPending("chat-1"), false);
});

test("ImPermissionHelper keeps queued requests when cleanup is deferred before next prompt delivery", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-2", toolName: "write_file", payload: {},
  });
  const answer = await helper.answerWithState("chat-1", "1", gateway);
  helper.clearAfterTurn("chat-1");

  assert.match(helper.takeNextPrompt("chat-1", answer?.answerToken) ?? "", /write_file/);
  helper.confirmNextPrompt("chat-1", true, "request-2", answer?.answerToken);
  assert.equal(helper.hasPending("chat-1"), true);
  assert.equal(await helper.answerWithState("chat-1", "0", gateway).then((result) => result?.canAdvance), true);
});

test("ImPermissionHelper defers turn cleanup while permission decision is in flight", async () => {
  const helper = new ImPermissionHelper();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gateway = {
    permissionDecide: async () => {
      await gate;
      return { delivered: true };
    },
  } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  const answer = helper.answerWithState("chat-1", "1", gateway);
  helper.clearAfterTurn("chat-1");
  release();

  const result = await answer;
  assert.equal(result?.canAdvance, true);
  assert.equal(helper.isAnswering("chat-1"), true);
  assert.equal(helper.takeNextPrompt("chat-1", result?.answerToken), undefined);
  assert.equal(helper.isAnswering("chat-1"), false);
});

test("ImPermissionHelper preserves an initial prompt retry across turn cleanup", async () => {
  const helper = new ImPermissionHelper();
  const gateway = { permissionDecide: async () => ({ delivered: true }) } as unknown as Gateway;
  helper.capture("chat-1", "session-1", {
    type: "permission_request", requestId: "request-1", toolName: "read_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1", false);
  helper.clearAfterTurn("chat-1");

  assert.equal((await helper.answerWithState("chat-1", "1", gateway))?.retryPrompt, true);
  assert.match(helper.takeNextPrompt("chat-1") ?? "", /read_file/);
  helper.confirmNextPrompt("chat-1", true, "request-1");
  assert.equal((await helper.answerWithState("chat-1", "1", gateway))?.canAdvance, true);
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
  helper.confirmInitialPrompt("chat-1");
  const oldAnswer = helper.answer("chat-1", "1", gateway);
  helper.clear("chat-1");
  helper.capture("chat-1", "new-session", {
    type: "permission_request", requestId: "new-request", toolName: "write_file", payload: {},
  });
  helper.confirmInitialPrompt("chat-1");
  const newAnswer = helper.answer("chat-1", "1", gateway);

  assert.equal(await newAnswer, "已允许一次，继续执行。");
  assert.equal(helper.takeNextPrompt("chat-1"), undefined);
  assert.equal(helper.hasPending("chat-1"), false);
  releaseOld();
  assert.equal(await oldAnswer, undefined);
  assert.deepEqual(decisions, ["old-request", "new-request"]);
  assert.equal(helper.isAnswering("chat-1"), false);
  assert.equal((helper as any).generations.size, 0);
});
