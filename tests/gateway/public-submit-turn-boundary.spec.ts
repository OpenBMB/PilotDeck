import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePublicSubmitTurnParams } from "../../src/gateway/server/GatewayWsConnection.js";

test("the public WebSocket boundary strips trusted in-process turn controls", () => {
  const sanitized = sanitizePublicSubmitTurnParams({
    sessionKey: "session-1",
    channelKey: "web",
    message: "hello",
    origin: { kind: "internal", source: "spoofed" },
    signal: { aborted: false },
  });

  assert.deepEqual(sanitized, {
    sessionKey: "session-1",
    channelKey: "web",
    message: "hello",
  });
});
