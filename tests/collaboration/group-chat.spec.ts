import assert from "node:assert/strict";
import test from "node:test";

import { GroupChatRuntime } from "../../src/collaboration/index.js";
import { RemotePilotDeckClient } from "../../src/collaboration/participants/RemotePilotDeckClient.js";
import { StaffDeckClient } from "../../src/collaboration/participants/StaffDeckClient.js";
import type { GroupChatInvocation } from "../../src/collaboration/protocol/types.js";

function sequenceUuid(): () => string {
  let value = 0;
  return () => String(++value);
}

test("group chat keeps room membership and a shared transcript scoped to the owner session", async () => {
  const runtime = new GroupChatRuntime({
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    uuid: sequenceUuid(),
  });
  const room = runtime.createRoom({
    ownerSessionId: "session-1",
    title: "Release review",
    participants: [
      { id: "engineer", kind: "pilotdeck_local", name: "Engineer", role: "implementation" },
      { id: "reviewer", kind: "staffdeck_mock", name: "Reviewer", employeeId: "mock-reviewer" },
    ],
  });

  const invocations: string[] = [];
  const round = await runtime.sendMessage({
    ownerSessionId: "session-1",
    roomId: room.id,
    content: "Review the rollout plan.",
    invoke: async ({ participant, transcript }) => {
      invocations.push(participant.id);
      assert.match(transcript, /PilotDeck main agent.*Review the rollout plan/u);
      return `${participant.name} response`;
    },
  });

  assert.deepEqual(invocations, ["engineer", "reviewer"]);
  assert.equal(round.replies.length, 2);
  assert.ok(round.replies.every((reply) => reply.ok));
  assert.deepEqual(round.room.messages.map((message) => message.senderId), ["main", "engineer", "reviewer"]);
  assert.equal(runtime.listRooms("session-1").length, 1);
  assert.equal(runtime.listRooms("session-2").length, 0);
  assert.throws(() => runtime.getRoom("session-2", room.id), /not found in this session/u);

  runtime.closeRoom("session-1", room.id);
  await assert.rejects(
    runtime.sendMessage({
      ownerSessionId: "session-1",
      roomId: room.id,
      content: "One more round",
      invoke: async () => "reply",
    }),
    /is closed/u,
  );
});

test("group chat rejects arbitrary environment variables as remote credentials", () => {
  const runtime = new GroupChatRuntime();
  assert.throws(() => runtime.createRoom({
    ownerSessionId: "session-1",
    title: "Unsafe remote",
    participants: [{
      id: "remote",
      kind: "pilotdeck_remote",
      name: "Remote",
      endpoint: "https://example.com",
      tokenEnv: "AWS_SECRET_ACCESS_KEY",
    }],
  }), /must be a dedicated variable/u);
});

test("remote PilotDeck client uses the existing OpenAI-compatible channel and stable group session", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "remote contribution" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new RemotePilotDeckClient({ fetchImpl });
  const invocation = sampleInvocation({
    id: "remote",
    kind: "pilotdeck_remote",
    name: "Remote PilotDeck",
    endpoint: "http://127.0.0.1:8642",
    tokenEnv: "PILOTDECK_GROUP_REMOTE_TOKEN",
  });

  const reply = await client.invoke(invocation, "group prompt", { PILOTDECK_GROUP_REMOTE_TOKEN: "secret" });

  assert.equal(reply, "remote contribution");
  assert.equal(requests[0]?.url, "http://127.0.0.1:8642/v1/chat/completions");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret");
  assert.match(requests[0]?.headers.get("x-hermes-session-id") ?? "", /^group%3Aroom-1%3Aremote$/u);
  assert.equal((requests[0]?.body.messages as Array<{ content: string }>)[0]?.content, "group prompt");
});

test("StaffDeck Open API v1 client lists employees, reuses sessions, and waits for Run results", async () => {
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body?: Record<string, unknown>;
  }> = [];
  let runCount = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      url: url.toString(),
      method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
    });
    if (url.pathname === "/api/v1/agents") {
      return new Response(JSON.stringify({ data: [
        { id: "employee-1", name: "Support", description: "Handles support requests" },
      ], next_cursor: null }), { status: 200 });
    }
    if (url.pathname.endsWith("/sessions") && method === "POST") {
      return new Response(JSON.stringify({ id: "staff-session-1" }), { status: 201 });
    }
    if (url.pathname.endsWith("/runs") && method === "POST") {
      runCount += 1;
      return new Response(JSON.stringify({ id: `run-${runCount}`, status: "queued" }), { status: 202 });
    }
    if (/\/runs\/run-\d+$/u.test(url.pathname)) {
      return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), status: "succeeded" }), { status: 200 });
    }
    if (/\/runs\/run-\d+\/result$/u.test(url.pathname)) {
      const runId = url.pathname.split("/").at(-2);
      return new Response(JSON.stringify({
        reply: runId === "run-1" ? "first reply" : "second reply",
        session_id: "staff-session-1",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  }) as typeof fetch;
  const client = new StaffDeckClient({ fetchImpl, pollIntervalMs: 0 });
  const connection = client.resolveConnection({
    STAFFDECK_BASE_URL: "http://127.0.0.1:10087/",
    STAFFDECK_API_KEY: "test-api-key",
  });
  assert.ok(connection);
  assert.equal(connection.protocol, "open_api_v1");
  assert.equal(connection.baseUrl, "http://127.0.0.1:10087/api/v1");
  const invocation = sampleInvocation({
    id: "support",
    kind: "staffdeck",
    name: "Support",
    employeeId: "employee-1",
  });

  const employees = await client.listEmployees(connection);
  assert.deepEqual(employees, [{
    id: "employee-1",
    name: "Support",
    description: "Handles support requests",
    source: "staffdeck",
    access: "accessible",
    publishedToGallery: false,
  }]);
  assert.equal(await client.invoke(invocation, "first", connection), "first reply");
  assert.equal(await client.invoke(invocation, "second", connection), "second reply");
  const sessionRequests = requests.filter((request) => request.url.endsWith("/sessions"));
  const runRequests = requests.filter((request) => request.url.endsWith("/runs"));
  assert.equal(sessionRequests.length, 1);
  assert.equal(runRequests.length, 2);
  assert.equal(sessionRequests[0]?.headers.get("authorization"), "Bearer test-api-key");
  assert.match(sessionRequests[0]?.headers.get("idempotency-key") ?? "", /^pilotdeck-session-/u);
  assert.match(runRequests[0]?.headers.get("idempotency-key") ?? "", /^pilotdeck-run-/u);
  assert.notEqual(runRequests[0]?.headers.get("idempotency-key"), runRequests[1]?.headers.get("idempotency-key"));
  assert.equal(runRequests[0]?.body?.session_id, "staff-session-1");
  assert.equal(runRequests[0]?.body?.tenant_id, undefined);
});

test("StaffDeck Open API v1 client exposes an awaiting-input prompt and structured failures", async () => {
  let mode: "awaiting" | "failed" = "awaiting";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/sessions") && method === "POST") {
      return new Response(JSON.stringify({ id: "session-1" }), { status: 201 });
    }
    if (url.pathname.endsWith("/runs") && method === "POST") {
      return new Response(JSON.stringify({ id: `run-${mode}`, status: "queued" }), { status: 202 });
    }
    if (url.pathname.endsWith(`/runs/run-${mode}`)) {
      return new Response(JSON.stringify(mode === "awaiting"
        ? { status: "awaiting_input" }
        : {
          status: "failed",
          error: { code: "MODEL_UNAVAILABLE", message: "Configured model is offline" },
        }), { status: 200 });
    }
    if (url.pathname.endsWith("/result")) {
      return new Response(JSON.stringify({ awaiting_input: { prompt: "请提供发票号码" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new StaffDeckClient({ fetchImpl, pollIntervalMs: 0 });
  const connection = client.resolveConnection({
    STAFFDECK_BASE_URL: "http://staffdeck.local/api/v1",
    STAFFDECK_API_KEY: "test-key",
  });
  assert.ok(connection);
  const invocation = sampleInvocation({
    id: "finance",
    kind: "staffdeck",
    name: "Finance",
    employeeId: "finance-1",
  });

  assert.equal(
    await client.invoke(invocation, "check receipt", connection),
    "StaffDeck 员工需要补充信息：请提供发票号码",
  );
  mode = "failed";
  await assert.rejects(
    client.invoke({
      ...invocation,
      sourceMessage: { ...invocation.sourceMessage, id: "message-2" },
    }, "try again", connection),
    /run-failed failed: MODEL_UNAVAILABLE: Configured model is offline/u,
  );
});

test("StaffDeck client keeps the legacy tenant chat adapter during migration", async () => {
  const postedBodies: Array<Record<string, unknown>> = [];
  const requestPaths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    if (url.pathname === "/api/enterprise/agents") {
      return new Response(JSON.stringify([
        {
          id: "employee-1",
          name: "Support",
          description: "Handles support requests",
          metadata: { published_to_gallery: true, created_by_username: "publisher" },
        },
      ]), { status: 200 });
    }
    if (url.pathname === "/api/chat/agents/employee-1/use") {
      return new Response(JSON.stringify({ id: "employee-1", name: "Support" }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    postedBodies.push(body);
    return new Response(JSON.stringify({
      reply: postedBodies.length === 1 ? "first reply" : "second reply",
      session_id: "staff-session-1",
    }), { status: 200 });
  }) as typeof fetch;
  const client = new StaffDeckClient({ fetchImpl });
  const connection = client.resolveConnection({
    STAFFDECK_BASE_URL: "http://127.0.0.1:5173",
    STAFFDECK_TENANT_ID: "tenant-1",
    STAFFDECK_API_TOKEN: "token",
  });
  assert.ok(connection);
  assert.equal(connection.protocol, "legacy_chat");
  const invocation = sampleInvocation({
    id: "support",
    kind: "staffdeck",
    name: "Support",
    employeeId: "employee-1",
  });

  assert.equal((await client.listEmployees(connection))[0]?.id, "employee-1");
  assert.equal(await client.invoke(invocation, "first", connection), "first reply");
  assert.equal(await client.invoke(invocation, "second", connection), "second reply");
  assert.equal(postedBodies[0]?.agent_id, "employee-1");
  assert.equal(postedBodies[0]?.session_id, undefined);
  assert.equal(postedBodies[1]?.session_id, "staff-session-1");
  assert.deepEqual(requestPaths, [
    "/api/enterprise/agents",
    "/api/chat/agents/employee-1/use",
    "/api/chat/turn",
    "/api/chat/turn",
  ]);
});

test("StaffDeck account login discovers owned and public employees without a PilotDeck allowlist", async () => {
  let loginCount = 0;
  const authorizations: string[] = [];
  const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .toString("base64url");
  const token = `header.${tokenPayload}.signature`;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/auth/login") {
      loginCount += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.username, "member-user");
      assert.equal(body.tenant_id, "tenant-demo");
      return new Response(JSON.stringify({ access_token: token }), { status: 200 });
    }
    authorizations.push(headers.get("authorization") ?? "");
    if (url.pathname === "/api/enterprise/agents") {
      return new Response(JSON.stringify([
        {
          id: "owned-1",
          name: "我的员工",
          status: "active",
          metadata: {
            owner_user_id: "user-1",
            owner_username: "member-user",
            owner_display_name: "Member User",
            role_name: "研发",
            expertise_tags: ["TypeScript", "Agent"],
            used_by_current_user: true,
          },
        },
        {
          id: "public-1",
          name: "公开法务",
          status: "active",
          metadata: {
            published_to_gallery: true,
            created_by_user_id: "publisher-1",
            created_by_username: "publisher",
            created_by_display_name: "Publisher",
            role_name: "法务",
            used_by_current_user: false,
          },
        },
        { id: "overall", name: "开放广场", status: "active", is_overall: true },
      ]), { status: 200 });
    }
    if (url.pathname === "/api/chat/agents/public-1/use") {
      return new Response(JSON.stringify({ id: "public-1", name: "公开法务" }), { status: 200 });
    }
    if (url.pathname === "/api/chat/turn") {
      return new Response(JSON.stringify({ reply: "Legal reply", session_id: "session-legal" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new StaffDeckClient({ fetchImpl });
  const connection = client.resolveConnection({
    STAFFDECK_BASE_URL: "http://staffdeck.local",
    STAFFDECK_TENANT_ID: "tenant-demo",
    STAFFDECK_USERNAME: "member-user",
    STAFFDECK_PASSWORD: "test-password",
    STAFFDECK_API_KEY: "single-agent-key-is-not-selected",
  });
  assert.ok(connection);
  assert.equal(connection.protocol, "legacy_chat");
  const employees = await client.listEmployees(connection);
  assert.deepEqual(employees, [
    {
      id: "owned-1",
      name: "我的员工",
      source: "staffdeck",
      access: "owned",
      creatorUserId: "user-1",
      creatorUsername: "member-user",
      creatorDisplayName: "Member User",
      publishedToGallery: false,
      usedByCurrentUser: true,
      roleName: "研发",
      expertiseTags: ["TypeScript", "Agent"],
    },
    {
      id: "public-1",
      name: "公开法务",
      source: "staffdeck",
      access: "public",
      creatorUserId: "publisher-1",
      creatorUsername: "publisher",
      creatorDisplayName: "Publisher",
      publishedToGallery: true,
      usedByCurrentUser: false,
      roleName: "法务",
    },
  ]);
  const invocation = sampleInvocation({
    id: "public-1",
    kind: "staffdeck",
    name: "公开法务",
    employeeId: "public-1",
  });
  assert.equal(await client.invoke(invocation, "check account", connection), "Legal reply");
  assert.equal(loginCount, 1);
  assert.deepEqual(authorizations, [`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
});

function sampleInvocation(
  participant: GroupChatInvocation["participant"],
): GroupChatInvocation {
  return {
    participant,
    room: {
      id: "room-1",
      ownerSessionId: "session-1",
      title: "Test room",
      status: "active",
      participants: [participant],
      messages: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    sourceMessage: {
      id: "message-1",
      roomId: "room-1",
      senderId: "main",
      senderName: "PilotDeck main agent",
      senderKind: "pilotdeck_main",
      content: "test",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    transcript: "Group: Test room\n[PilotDeck main agent | pilotdeck_main] test",
  };
}
