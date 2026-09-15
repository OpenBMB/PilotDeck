import assert from "node:assert/strict";
import test from "node:test";

import { McpClient, McpClientError } from "../../../src/mcp/client/McpClient.js";
import { McpRuntime } from "../../../src/mcp/runtime/McpRuntime.js";
import type { PilotDeckMcpServerSpec } from "../../../src/mcp/protocol/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const baseSpec: PilotDeckMcpServerSpec = {
  id: "server",
  transport: "stdio",
  command: "node",
};

const stubTransportFactory = (behaviour: () => Promise<void>): ((spec: PilotDeckMcpServerSpec) => Transport) => {
  return (_spec: PilotDeckMcpServerSpec) => {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      close: async () => undefined,
      // The Transport interface has more members; the client only calls
      // start → connect during handshake. We throw immediately so `start`
      // surfaces the error the test is asserting on.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({} as any),
    } as Transport;
  };
};

const customErrorClient = async (): Promise<never> => {
  // Throwing a non-Error value (a plain string) used to produce
  // `error: undefined` in the status entry.
  throw "boom (non-Error throw)";
};

test("McpRuntime.start: status entry uses the McpClientError message when it surfaces", async () => {
  const client = new McpClient(baseSpec, {
    transportFactory: () => {
      throw new McpClientError("handshake exploded", "mcp_handshake_failed", "server");
    },
  });
  const runtime = new McpRuntime([baseSpec]);
  // Replace the auto-created client with our failing one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime as any).clients.set(baseSpec.id, client);
  const results = await runtime.start();
  assert.equal(results.length, 1);
  assert.equal(results[0].serverId, "server");
  assert.equal(results[0].status, "error");
  assert.equal(results[0].error, "handshake exploded");
});

test("McpRuntime.start: Error-subclass throws carry their message through", async () => {
  const client = new McpClient(baseSpec, {
    transportFactory: () => {
      throw new TypeError("bad transport");
    },
  });
  const runtime = new McpRuntime([baseSpec]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime as any).clients.set(baseSpec.id, client);
  const results = await runtime.start();
  assert.equal(results[0].status, "error");
  assert.equal(results[0].error, "bad transport");
});

test("McpRuntime.start: non-Error throws fall back to String(err)", async () => {
  const client = new McpClient(baseSpec, {
    transportFactory: () => {
      throw "boom (non-Error throw)";
    },
  });
  const runtime = new McpRuntime([baseSpec]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime as any).clients.set(baseSpec.id, client);
  const results = await runtime.start();
  assert.equal(results[0].status, "error");
  assert.equal(results[0].error, "boom (non-Error throw)", "non-Error throws must coerce to a string");
});

test("McpRuntime.start: non-Error throws of null/undefined surface as 'null' / 'undefined'", async () => {
  const runtime1 = new McpRuntime([baseSpec]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime1 as any).clients.set(baseSpec.id, new McpClient(baseSpec, { transportFactory: () => { throw null; } }));
  const r1 = await runtime1.start();
  assert.equal(r1[0].error, "null");

  const runtime2 = new McpRuntime([baseSpec]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime2 as any).clients.set(baseSpec.id, new McpClient(baseSpec, { transportFactory: () => { throw undefined; } }));
  const r2 = await runtime2.start();
  assert.equal(r2[0].error, "undefined");
});

// Keep an explicit reference to avoid `noUnusedParameters` complaints.
void customErrorClient;
void stubTransportFactory;
