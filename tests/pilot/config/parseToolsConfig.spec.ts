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

test("trans speech requires complete runtime configuration when enabled", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseToolsConfig({
    transSpeech: {
      enabled: true,
      baseUrl: "http://trans-speech:8090",
      language: "zh",
      asrProfile: "sensevoice",
      diarize: true,
      timeoutMs: 330000,
      maxConcurrentTasks: 1,
      generate: { polish: true, minutes: true, actions: false },
    },
  }, diagnostics);

  assert.deepEqual(config?.transSpeech, {
    enabled: true,
    baseUrl: "http://trans-speech:8090",
    language: "zh",
    asrProfile: "sensevoice",
    diarize: true,
    timeoutMs: 330000,
    maxConcurrentTasks: 1,
    generate: { polish: true, minutes: true, actions: false },
  });
  assert.deepEqual(diagnostics, []);
});

test("trans speech can be disabled without operational fields", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseToolsConfig({ transSpeech: { enabled: false } }, diagnostics);
  assert.deepEqual(config, { transSpeech: { enabled: false } });
  assert.deepEqual(diagnostics, []);
});

test("trans speech rejects non-positive concurrency", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  parseToolsConfig({
    transSpeech: {
      enabled: true,
      baseUrl: "http://trans-speech:8090",
      language: "zh",
      asrProfile: "sensevoice",
      diarize: true,
      timeoutMs: 330000,
      maxConcurrentTasks: 0,
      generate: { polish: true, minutes: true, actions: false },
    },
  }, diagnostics);
  assert.equal(diagnostics.some((item) => item.code === "TOOLS_TRANS_SPEECH_CONCURRENCY_INVALID"), true);
});

test("trans speech accepts the Compose service name or a private deployment address", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseToolsConfig({
    transSpeech: {
      enabled: true,
      baseUrl: "http://172.16.21.9:8090",
      language: "zh",
      asrProfile: "sensevoice",
      diarize: true,
      timeoutMs: 330000,
      maxConcurrentTasks: 1,
      generate: { polish: true, minutes: true, actions: false },
    },
  }, diagnostics);

  assert.equal(config?.transSpeech?.enabled, true);
  if (!config?.transSpeech?.enabled) assert.fail("expected enabled Trans-Speech configuration");
  assert.equal(config.transSpeech.baseUrl, "http://172.16.21.9:8090");
  assert.deepEqual(diagnostics, []);
});

test("trans speech rejects public, credentialed, or non-HTTP service addresses", () => {
  for (const baseUrl of ["https://172.16.21.9:8090", "http://example.com:8090", "http://user:password@172.16.21.9:8090"]) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    parseToolsConfig({
      transSpeech: {
        enabled: true,
        baseUrl,
        language: "zh",
        asrProfile: "sensevoice",
        diarize: true,
        timeoutMs: 330000,
        maxConcurrentTasks: 1,
        generate: { polish: true, minutes: true, actions: false },
      },
    }, diagnostics);

    assert.equal(diagnostics.some((item) => item.code === "TOOLS_TRANS_SPEECH_BASE_URL_INVALID"), true);
  }
});
