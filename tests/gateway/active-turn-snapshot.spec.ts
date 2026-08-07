import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import type { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

type ActiveTurnReplayStore = {
  activeTurnReplays: Map<string, {
    sessionKey: string;
    runId: string;
    events: GatewayEvent[];
    bytes: number;
    truncated: boolean;
  }>;
};

class FakeTextWebSocketConnection {
  readonly sent: unknown[] = [];
  private messageHandler?: (message: string) => void;

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(_handler: () => void): void {}

  sendText(message: string): void {
    this.sent.push(JSON.parse(message));
  }

  close(): void {}

  dispatch(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("status-only active turn snapshots omit buffered events", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  const event: GatewayEvent = { type: "assistant_text_delta", text: "still running" };
  const replays = (gateway as unknown as ActiveTurnReplayStore).activeTurnReplays;

  replays.set("cron:status-only", {
    sessionKey: "cron:status-only",
    runId: "run-1",
    get events(): GatewayEvent[] {
      throw new Error("status-only polling must not read buffered events");
    },
    bytes: 1,
    truncated: false,
  });

  const statusOnly = await gateway.getActiveTurnSnapshot({ sessionKey: "cron:status-only", includeEvents: false });
  assert.equal(statusOnly.active, true);
  assert.deepEqual(statusOnly.events, []);

  replays.set("cron:active", {
    sessionKey: "cron:active",
    runId: "run-1",
    events: [event],
    bytes: 1,
    truncated: false,
  });

  const replay = await gateway.getActiveTurnSnapshot({ sessionKey: "cron:active" });
  assert.deepEqual(replay.events, [event]);
  assert.notEqual(replay.events[0], event, "default replay remains a defensive copy");
});

test("status-only active turn snapshots preserve includeEvents through remote and WebSocket gateways", async () => {
  const input = { sessionKey: "cron:status-only", includeEvents: false };
  const expected = { active: true, sessionKey: input.sessionKey, events: [] };

  let remoteMethod: string | undefined;
  let remoteInput: unknown;
  const remote = new RemoteGateway({
    request: async (method: string, received: unknown) => {
      remoteMethod = method;
      remoteInput = received;
      return expected;
    },
  } as unknown as GatewayWsClient);
  assert.deepEqual(await remote.getActiveTurnSnapshot(input), expected);
  assert.equal(remoteMethod, "active_turn_snapshot");
  assert.deepEqual(remoteInput, input);

  let websocketInput: typeof input | undefined;
  const socket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway: {
      describeServer: async () => ({ mode: "in_process" }),
      getActiveTurnSnapshot: async (received: typeof input) => {
        websocketInput = received;
        return expected;
      },
    } as unknown as Gateway,
  });
  socket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  socket.dispatch({ type: "request", id: "active-turn-status-only", method: "active_turn_snapshot", params: input });
  await flushAsyncWork();

  assert.deepEqual(websocketInput, input);
  assert.deepEqual(socket.sent.at(-1), {
    type: "response",
    id: "active-turn-status-only",
    ok: true,
    result: expected,
  });
});
