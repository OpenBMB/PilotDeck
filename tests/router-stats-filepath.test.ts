import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ModelConfig } from "../src/model/index.js";
import { parseRouterConfig } from "../src/router/config/parseRouterConfig.js";
import { TokenStatsCollector } from "../src/router/stats/TokenStatsCollector.js";

const modelConfig: ModelConfig = { providers: {} };

function observeOneRecord(collector: TokenStatsCollector): void {
  collector.observe({
    sessionId: "session-1",
    scenarioType: "default",
    resolvedFrom: "scenario",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
    },
    startedAt: "2026-06-23T00:00:00.000Z",
    endedAt: "2026-06-23T00:00:01.000Z",
  });
}

test("parseRouterConfig preserves router.stats.filePath", () => {
  const filePath = "/tmp/custom-router-stats.jsonl";
  const result = parseRouterConfig(
    {
      stats: {
        enabled: true,
        filePath,
      },
    },
    modelConfig,
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.config?.stats?.filePath, filePath);
});

test("parseRouterConfig treats blank router.stats.filePath as unset", () => {
  const result = parseRouterConfig(
    {
      stats: {
        enabled: true,
        filePath: "",
      },
    },
    modelConfig,
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.config?.stats?.filePath, undefined);
});

test("TokenStatsCollector writes to the configured stats file path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-stats-"));
  const customPath = path.join(tempDir, "custom-name.jsonl");
  const defaultPath = path.join(tempDir, "stats.jsonl");

  try {
    const collector = new TokenStatsCollector({
      enabled: true,
      filePath: customPath,
    });

    observeOneRecord(collector);
    collector.dispose();

    assert.equal(fs.existsSync(customPath), true);
    assert.equal(fs.existsSync(defaultPath), false);

    const [line] = fs.readFileSync(customPath, "utf-8").trim().split("\n");
    const record = JSON.parse(line!);
    assert.equal(record.sessionId, "session-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TokenStatsCollector falls back to the default path for blank filePath", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-home-"));
  const previousPilotHome = process.env.PILOT_HOME;

  try {
    process.env.PILOT_HOME = tempHome;
    const collector = new TokenStatsCollector({
      enabled: true,
      filePath: "",
    });

    observeOneRecord(collector);
    collector.dispose();

    const defaultPath = path.join(tempHome, "router", "stats.jsonl");
    assert.equal(fs.existsSync(defaultPath), true);

    const [line] = fs.readFileSync(defaultPath, "utf-8").trim().split("\n");
    const record = JSON.parse(line!);
    assert.equal(record.sessionId, "session-1");
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
