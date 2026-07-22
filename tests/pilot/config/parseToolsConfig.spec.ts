import assert from "node:assert/strict";
import test from "node:test";

import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("web search can be explicitly disabled without discarding provider config", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig({
    webSearch: {
      enabled: false,
      provider: "tavily",
      apiKey: "test-key",
      endpoint: "https://example.test/search",
    },
  }, diagnostics);

  assert.deepEqual(config, {
    webSearch: {
      enabled: false,
      provider: "tavily",
      apiKey: "test-key",
      endpoint: "https://example.test/search",
    },
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

test("web search enabled must be a boolean", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parseToolsConfig({
    webSearch: { enabled: "false" },
  }, diagnostics);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "TOOLS_WEB_SEARCH_ENABLED_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});
