import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWebGatewayEvent,
  createWebMessageReducerState,
} from "../../src/web/client/webMessage.js";
import type { WebGatewayEvent } from "../../src/web/client/protocol.js";

const reducerOptions = {
  sessionKey: "web:s_test",
  now: () => new Date("2026-07-07T00:00:00.000Z"),
  newId: (() => {
    let next = 0;
    return () => `id-${++next}`;
  })(),
};

test("web reducer renders model_request_failed status message and user hint", () => {
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, { type: "turn_started", runId: "turn-1" }, reducerOptions);
  state = applyWebGatewayEvent(state, {
    type: "agent_status",
    event: "model_request_failed",
    detail: {
      message: "Provider rejected the request.",
      userHint: "Check the provider key.",
      visible: true,
    },
  }, reducerOptions);

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "error");
  assert.equal(state.messages[0]?.text, "Provider rejected the request.");
  assert.deepEqual(state.messages[0]?.payload, {
    event: "model_request_failed",
    detail: {
      message: "Provider rejected the request.",
      userHint: "Check the provider key.",
      visible: true,
    },
    userHint: "Check the provider key.",
  });
});

test("web reducer does not duplicate a generic error after visible failure status", () => {
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, { type: "turn_started", runId: "turn-1" }, reducerOptions);
  state = applyWebGatewayEvent(state, {
    type: "agent_status",
    event: "tool_error_loop",
    detail: {
      message: "The agent repeated the same tool error.",
      visible: true,
      userHint: "Change the request.",
    },
  }, reducerOptions);
  state = applyWebGatewayEvent(state, {
    type: "error",
    code: "agent_tool_error_loop",
    message: "Generic turn_failed copy.",
    recoverable: false,
  }, reducerOptions);

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.text, "The agent repeated the same tool error.");
});

test("web reducer carries model_empty_response_exhausted userHint", () => {
  const event: WebGatewayEvent = {
    type: "agent_status",
    event: "model_empty_response_exhausted",
    detail: {
      message: "The model returned empty content repeatedly.",
      userHint: "Increase max output tokens.",
      visible: true,
    },
  };
  const state = applyWebGatewayEvent(createWebMessageReducerState(), event, reducerOptions);

  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0]?.payload, {
    event: "model_empty_response_exhausted",
    detail: {
      message: "The model returned empty content repeatedly.",
      userHint: "Increase max output tokens.",
      visible: true,
    },
    userHint: "Increase max output tokens.",
  });
});

test("web reducer renders visible preflight status by detail shape and dedupes error", () => {
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, {
    type: "agent_status",
    event: "custom_preflight_failed",
    detail: {
      message: "Gateway is unavailable.",
      code: "gateway_unavailable",
      severity: "error",
      visible: true,
      userHint: "Start the gateway and retry.",
      scope: "preflight",
      source: "web_http",
    },
  }, reducerOptions);
  state = applyWebGatewayEvent(state, {
    type: "error",
    code: "gateway_unavailable",
    message: "Legacy duplicate.",
    recoverable: true,
  }, reducerOptions);

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "error");
  assert.equal(state.messages[0]?.text, "Gateway is unavailable.");
  assert.deepEqual(state.messages[0]?.payload, {
    event: "custom_preflight_failed",
    detail: {
      message: "Gateway is unavailable.",
      code: "gateway_unavailable",
      severity: "error",
      visible: true,
      userHint: "Start the gateway and retry.",
      scope: "preflight",
      source: "web_http",
    },
    userHint: "Start the gateway and retry.",
  });
});
