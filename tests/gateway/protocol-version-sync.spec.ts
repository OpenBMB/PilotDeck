import assert from "node:assert/strict";
import test from "node:test";

import { GatewayBrowserClient } from "../../src/web/client/GatewayBrowserClient.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB } from "../../src/web/client/protocol.js";
import type { WebGatewayEvent } from "../../src/web/client/protocol.js";

test("browser and canonical gateway clients use the same protocol version", () => {
  assert.equal(PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB, PILOTDECK_GATEWAY_PROTOCOL_VERSION);
});

test("browser gateway client exposes the steer RPCs added in protocol 1.1", () => {
  assert.equal(typeof GatewayBrowserClient.prototype.steerTurn, "function");
  assert.equal(typeof GatewayBrowserClient.prototype.cancelSteer, "function");
});

test("browser gateway protocol includes assistant attachment events", () => {
  const event: WebGatewayEvent = {
    type: "assistant_attachment",
    attachment: {
      type: "image",
      content: "aW1hZ2U=",
      mimeType: "image/png",
      source: "tool_result",
    },
  };
  assert.equal(event.attachment.source, "tool_result");
});
