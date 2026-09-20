import assert from "node:assert/strict";
import test from "node:test";

import { GatewayBrowserClient } from "../../src/web/client/GatewayBrowserClient.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB } from "../../src/web/client/protocol.js";

test("browser and canonical gateway clients use the same protocol version", () => {
  assert.equal(PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB, PILOTDECK_GATEWAY_PROTOCOL_VERSION);
});

test("browser gateway client exposes the steer RPCs retained by the current protocol", () => {
  assert.equal(typeof GatewayBrowserClient.prototype.steerTurn, "function");
  assert.equal(typeof GatewayBrowserClient.prototype.cancelSteer, "function");
  assert.equal(typeof Object.getOwnPropertyDescriptor(GatewayBrowserClient.prototype, "interactionBinding")?.get, "function");
  assert.equal(typeof GatewayBrowserClient.prototype.reconnectInteraction, "function");
});
