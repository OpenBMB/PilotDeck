import assert from "node:assert/strict";
import test from "node:test";

import { createAgentStatusHttpErrorBody } from "../../src/status/agentStatus.js";

test("createAgentStatusHttpErrorBody returns compatible error and agent_status payload", () => {
  const body = createAgentStatusHttpErrorBody({
    event: "gateway_unavailable",
    message: "Gateway not ready",
    code: "gateway_unavailable",
    status: 503,
    type: "server_error",
    userHint: "Start the gateway and retry.",
    scope: "preflight",
    source: "api_server",
  });

  assert.deepEqual(body.error, {
    message: "Gateway not ready",
    type: "server_error",
    code: "gateway_unavailable",
    userHint: "Start the gateway and retry.",
    status: 503,
    scope: "preflight",
    source: "api_server",
    event: "gateway_unavailable",
  });
  assert.deepEqual(body.agent_status, {
    type: "agent_status",
    event: "gateway_unavailable",
    detail: {
      message: "Gateway not ready",
      code: "gateway_unavailable",
      severity: "error",
      visible: true,
      userHint: "Start the gateway and retry.",
      scope: "preflight",
      source: "api_server",
      status: 503,
    },
  });
});
