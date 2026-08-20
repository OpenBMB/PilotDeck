import assert from "node:assert/strict";
import test from "node:test";

import {
  getGlobalProxyStateForTesting,
  installGlobalProxy,
  reinstallGlobalProxy,
} from "../../src/cli/proxy.js";

test("concurrent initial proxy installs share the first effective install", async (t) => {
  await reinstallGlobalProxy(undefined);
  t.after(() => reinstallGlobalProxy(undefined));

  const firstUrl = "http://first-proxy.example.test:8080";
  const secondUrl = "http://second-proxy.example.test:8080";
  const results = await Promise.all([
    installGlobalProxy(firstUrl, "first-bypass.example.test"),
    installGlobalProxy(secondUrl, "second-bypass.example.test"),
  ]);

  assert.deepEqual(results, [firstUrl, firstUrl]);
  const state = getGlobalProxyStateForTesting();
  assert.equal(state?.mode, "proxy");
  if (state?.mode !== "proxy") assert.fail("expected proxy dispatcher state");
  assert.equal(state.proxyUrl, firstUrl);
  assert.equal(state.source, "config");
  assert.match(state.noProxy, /first-bypass\.example\.test/);
  assert.doesNotMatch(state.noProxy, /second-bypass\.example\.test/);
  assert.match(state.noProxy, /127\.0\.0\.1/);
  assert.match(state.noProxy, /localhost/);
});
