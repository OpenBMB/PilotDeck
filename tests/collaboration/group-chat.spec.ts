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

test("StaffDeck client lists employees and reuses the returned employee session", async () => {
  const postedBodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/chat/agents") {
      return new Response(JSON.stringify([
        { id: "employee-1", name: "Support", description: "Handles support requests" },
      ]), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    postedBodies.push(body);
    return new Response(JSON.stringify({
      reply: postedBodies.length === 1 ? "first reply" : "second reply",
      session_id: "staff-session-1",
    }), { status: 200 });
  }) as typeof fetch;
  const client = new StaffDeckClient({ fetchImpl });
  const connection = { baseUrl: "http://127.0.0.1:5173", tenantId: "tenant-1", token: "token" };
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
  }]);
  assert.equal(await client.invoke(invocation, "first", connection), "first reply");
  assert.equal(await client.invoke(invocation, "second", connection), "second reply");
  assert.equal(postedBodies[0]?.agent_id, "employee-1");
  assert.equal(postedBodies[0]?.session_id, undefined);
  assert.equal(postedBodies[1]?.session_id, "staff-session-1");
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
