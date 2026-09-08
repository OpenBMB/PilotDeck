import assert from "node:assert/strict";
import test from "node:test";

import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

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
