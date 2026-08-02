import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApiServerChannel } from "../../src/adapters/index.js";
import type { Gateway, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("versioned group-turn authenticates, maps workspaces, scopes collaboration, and deduplicates retries", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-api-group-turn-"));
  const workspace = join(pilotHome, "workspace");
  const oldPilotHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = pilotHome;
  t.after(async () => {
    if (oldPilotHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = oldPilotHome;
    await rm(pilotHome, { recursive: true, force: true });
  });

  const submissions: GatewaySubmitTurnInput[] = [];
  const gateway = {
    submitTurn: async function* (input: GatewaySubmitTurnInput) {
      submissions.push(input);
      yield { type: "turn_started", runId: "remote-run" } as const;
      yield { type: "assistant_thinking_delta", text: "checking roster" } as const;
      yield { type: "assistant_text_delta", text: "remote reply" } as const;
      yield { type: "turn_completed", usage: {}, finishReason: "completed" } as const;
    },
  } as unknown as Gateway;
  const port = await freePort();
  const channel = new ApiServerChannel({
    host: "127.0.0.1",
    port,
    apiKey: "worker-secret",
    workspaceMappings: { shared: workspace },
  });
  const handle = await channel.start({ gateway, logger: {} } as never);
  t.after(() => handle.stop("test complete"));
  const baseUrl = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${baseUrl}/v1/models`)).status, 401);
  const modelResponse = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: "Bearer worker-secret" } });
  assert.equal(modelResponse.status, 200);
  assert.deepEqual((await modelResponse.json() as { workspaceKeys: string[] }).workspaceKeys, ["shared"]);

  const body = {
    version: 1,
    roomId: "room-1",
    roundId: "round-1",
    entryMemberId: "alice-entry",
    workspaceKey: "shared",
    message: "Ask Bob for a review",
    rosterContext: "Bob id=bob-reviewer",
    requiredDelegates: ["bob-reviewer"],
    collaboration: {
      canDelegate: true,
      coordinatorUrl: "http://127.0.0.1:3001",
      delegationToken: "turn-scoped-token",
    },
  };
  const send = () => fetch(`${baseUrl}/v1/group/turn`, {
    method: "POST",
    headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const first = await send();
  assert.equal(first.status, 200);
  const firstLines = (await first.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(firstLines.at(-1)?.cached, false);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.sessionKey, "group:room-1:alice-entry");
  assert.equal(submissions[0]?.workspaceCwd, workspace);
  assert.deepEqual(submissions[0]?.collaboration, {
    version: 1,
    kind: "group_turn",
    roomId: "room-1",
    turnId: "round-1",
    entryMemberId: "alice-entry",
    canDelegate: true,
    coordinatorUrl: "http://127.0.0.1:3001",
    delegationToken: "turn-scoped-token",
  });
  assert.ok(submissions[0]?.permissionRules?.deny?.some((rule) => rule.toolName === "write_file"));

  const retry = await send();
  assert.equal(retry.status, 200);
  const retryLines = (await retry.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(retryLines.at(-1)?.cached, true);
  assert.equal(submissions.length, 1);

  const unmapped = await fetch(`${baseUrl}/v1/group/turn`, {
    method: "POST",
    headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, roundId: "round-2", workspaceKey: "arbitrary-path" }),
  });
  assert.equal(unmapped.status, 404);
});

test("group-turn stays disabled until the remote worker configures an API key", async (t) => {
  const port = await freePort();
  const channel = new ApiServerChannel({
    host: "127.0.0.1",
    port,
    apiKey: "",
    workspaceMappings: { shared: process.cwd() },
  });
  const gateway = { submitTurn: async function* () { yield { type: "turn_completed", usage: {} } as const; } } as unknown as Gateway;
  const handle = await channel.start({ gateway, logger: {} } as never);
  t.after(() => handle.stop("test complete"));
  const response = await fetch(`http://127.0.0.1:${port}/v1/group/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 503);
});
