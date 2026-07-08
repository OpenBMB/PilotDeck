import assert from "node:assert/strict";
import test from "node:test";

import {
  LITELLM_COMPLETION_HTTP_FALLBACK_MS,
  LITELLM_HTTP_CONNECTOR_LIMIT,
  LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
} from "../../src/model/index.js";
import { createLongTimeoutOptions, UNDICI_TRANSPORT_TIMEOUT_MS } from "../../src/cli/proxy.js";

test("undici transport options use LiteLLM-compatible defaults", () => {
  assert.equal(UNDICI_TRANSPORT_TIMEOUT_MS, LITELLM_COMPLETION_HTTP_FALLBACK_MS);
  assert.deepEqual(createLongTimeoutOptions(), {
    headersTimeout: LITELLM_COMPLETION_HTTP_FALLBACK_MS,
    bodyTimeout: LITELLM_COMPLETION_HTTP_FALLBACK_MS,
    connections: LITELLM_HTTP_CONNECTOR_LIMIT,
    keepAliveTimeout: LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
  });
});
