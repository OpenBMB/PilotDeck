import assert from "node:assert/strict";
import test from "node:test";

import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("missing search configuration stays distinct from a present empty or legacy block", () => {
  for (const tools of [undefined, {}]) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    assert.equal(parseToolsConfig(tools, diagnostics), undefined);
    assert.deepEqual(diagnostics, []);
  }
  for (const [webSearch, warnings] of [
    [{}, []],
    [{ region: "cn" }, ["TOOLS_WEB_SEARCH_REGION_DEPRECATED"]],
    [{ unknownLegacyField: true }, ["TOOLS_WEB_SEARCH_UNKNOWN_FIELD"]],
  ] as const) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    assert.deepEqual(parseToolsConfig({ webSearch }, diagnostics), { webSearch: {} });
    assert.deepEqual(diagnostics.map(item => item.code), warnings);
    assert.ok(diagnostics.every(item => item.severity === "warning"));
  }
});

test("disabled web search ignores inactive provider fields", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig({
    webSearch: {
      enabled: false,
      provider: "invalid",
      apiKey: "",
      endpoint: "not-a-url",
      customProvider: { auth: "invalid" },
    },
  }, diagnostics);

  assert.deepEqual(config, {
    webSearch: { enabled: false },
  });
  assert.deepEqual(diagnostics, []);
});

test("web search enabled remains optional for backwards compatibility", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig({
    webSearch: { provider: "glm" },
  }, diagnostics);

  assert.deepEqual(config, { webSearch: { provider: "glm" } });
  assert.deepEqual(diagnostics, []);
});

test("web search accepts all configured providers", () => {
  for (const provider of ["glm", "tavily", "custom", "serper", "brave"] as const) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    const config = parseToolsConfig({ webSearch: { provider, apiKey: "test-key" } }, diagnostics);
    assert.deepEqual(config, { webSearch: { provider, apiKey: "test-key" } });
    assert.deepEqual(diagnostics, []);
  }
});

test("web search enabled must be a boolean", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parseToolsConfig({
    webSearch: { enabled: "false" },
  }, diagnostics);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "TOOLS_WEB_SEARCH_ENABLED_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});
