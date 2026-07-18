import test from "node:test";
import assert from "node:assert/strict";

import { buildBrowserUseArgs } from "../../src/cli/createLocalGateway.js";

test("browser-use args do not inherit generic proxy env by default", () => {
  const args = buildBrowserUseArgs(["--browser", "chromium"], "/tmp/pd-browser", {
    HTTPS_PROXY: "http://user:pass@example.test:8080",
  });

  assert.deepEqual(args.slice(0, 2), ["--browser", "chromium"]);
  assert.equal(args.includes("--proxy-server"), false);
  assert.equal(args.includes("http://user:pass@example.test:8080"), false);
  assert.deepEqual(args.slice(args.indexOf("--output-dir"), args.indexOf("--output-dir") + 2), [
    "--output-dir",
    "/tmp/pd-browser",
  ]);
});

test("browser-use args use explicit browser proxy server", () => {
  const args = buildBrowserUseArgs([], "/tmp/pd-browser", {
    PILOTDECK_BROWSER_PROXY_SERVER: "http://127.0.0.1:7890",
    NO_PROXY: "example.test",
  });

  assert.deepEqual(args.slice(args.indexOf("--proxy-server"), args.indexOf("--proxy-server") + 2), [
    "--proxy-server",
    "http://127.0.0.1:7890",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--proxy-bypass"), args.indexOf("--proxy-bypass") + 2), [
    "--proxy-bypass",
    "example.test,localhost,127.0.0.1,host.docker.internal",
  ]);
});

test("browser-use args only inherit generic proxy env when opted in", () => {
  const args = buildBrowserUseArgs([], "/tmp/pd-browser", {
    PILOTDECK_BROWSER_PROXY_FROM_ENV: "1",
    HTTPS_PROXY: "http://proxy.example.test:8080",
  }, {
    url: "http://config-proxy.example.test:7890",
  });

  assert.deepEqual(args.slice(args.indexOf("--proxy-server"), args.indexOf("--proxy-server") + 2), [
    "--proxy-server",
    "http://proxy.example.test:8080",
  ]);
});

test("browser-use args use config proxy when browser env proxy is absent", () => {
  const args = buildBrowserUseArgs([], "/tmp/pd-browser", {
    NO_PROXY: "env-bypass.example.test",
  }, {
    url: "http://config-proxy.example.test:7890",
    noProxy: "config-bypass.example.test",
  });

  assert.deepEqual(args.slice(args.indexOf("--proxy-server"), args.indexOf("--proxy-server") + 2), [
    "--proxy-server",
    "http://config-proxy.example.test:7890",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--proxy-bypass"), args.indexOf("--proxy-bypass") + 2), [
    "--proxy-bypass",
    "env-bypass.example.test,config-bypass.example.test,localhost,127.0.0.1,host.docker.internal",
  ]);
});

test("browser-use args allow explicit direct mode to disable config proxy", () => {
  const args = buildBrowserUseArgs([], "/tmp/pd-browser", {
    PILOTDECK_BROWSER_PROXY_SERVER: "direct",
  }, {
    url: "http://config-proxy.example.test:7890",
  });

  assert.equal(args.includes("--proxy-server"), false);
  assert.equal(args.includes("http://config-proxy.example.test:7890"), false);
});
