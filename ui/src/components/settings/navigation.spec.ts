import { describe, expect, it } from "vitest";
import {
  getModelReferenceTab,
  getSettingsPath,
  getSettingsPathFromTab,
  mapInitialTabToMenuKey,
  mapSettingsSectionToMenuKey,
} from "./navigation";

describe("mapInitialTabToMenuKey", () => {
  it("routes the Office preview deep link to its dedicated page", () => {
    expect(mapInitialTabToMenuKey("config:officePreview")).toBe(
      "officePreview",
    );
  });

  it("routes legacy config sections to their dedicated pages", () => {
    expect(mapInitialTabToMenuKey("config:models")).toBe("modelPool");
    expect(mapInitialTabToMenuKey("config:agents")).toBe("modelPool");
    expect(mapInitialTabToMenuKey("config:memory")).toBe("agentMemory");
    expect(mapInitialTabToMenuKey("config:tools")).toBe("agentSearch");
    expect(mapInitialTabToMenuKey("config:webSearch")).toBe("agentSearch");
    expect(mapInitialTabToMenuKey("config:router")).toBe("agentRoute");
    expect(mapInitialTabToMenuKey("config:gateway")).toBe("integrations");
    expect(mapInitialTabToMenuKey("config:alwaysOn")).toBe("agentResident");
    expect(mapInitialTabToMenuKey("config:cron")).toBe("agentSchedule");
    expect(mapInitialTabToMenuKey("config:customEnv")).toBe("advanced");
  });

  it("maps legacy top-level settings tabs to the new information architecture", () => {
    expect(mapInitialTabToMenuKey("permissions")).toBe("privacy");
    expect(mapInitialTabToMenuKey("mcp")).toBe("mcpServers");
    expect(mapInitialTabToMenuKey("gateway")).toBe("integrations");
    expect(mapInitialTabToMenuKey("config")).toBe("modelPool");
  });

  it("routes appearance to its page and defaults unknown tabs to General", () => {
    expect(mapInitialTabToMenuKey("appearance")).toBe("appearance");
    expect(mapInitialTabToMenuKey("unknown")).toBe("general");
    expect(mapInitialTabToMenuKey(undefined)).toBe("general");
  });

  it("maps URL slugs used by the settings route", () => {
    expect(mapInitialTabToMenuKey("models")).toBe("modelPool");
    expect(mapInitialTabToMenuKey("agent-search")).toBe("agentSearch");
    expect(mapInitialTabToMenuKey("privacy")).toBe("privacy");
  });
});

describe("settings route paths", () => {
  it("uses /settings for the general page", () => {
    expect(getSettingsPath("general")).toBe("/settings");
    expect(getSettingsPathFromTab("appearance")).toBe("/settings/appearance");
  });

  it("maps menu keys and legacy tabs onto dedicated settings URLs", () => {
    expect(getSettingsPath("modelPool")).toBe("/settings/models");
    expect(getSettingsPath("agentSearch")).toBe("/settings/agent-search");
    expect(getSettingsPathFromTab("config:tools")).toBe("/settings/agent-search");
    expect(getSettingsPathFromTab("permissions")).toBe("/settings/privacy");
  });

  it("reads the active menu key back from the URL section", () => {
    expect(mapSettingsSectionToMenuKey(undefined)).toBe("general");
    expect(mapSettingsSectionToMenuKey("models")).toBe("modelPool");
    expect(mapSettingsSectionToMenuKey("mcp")).toBe("mcpServers");
    expect(mapSettingsSectionToMenuKey("office")).toBe("officePreview");
  });
});


describe("model reference navigation", () => {
  it("retired model links open the model pool", () => {
    expect(getSettingsPathFromTab("agent-model")).toBe("/settings/models");
    expect(mapSettingsSectionToMenuKey("agent-model")).toBe("modelPool");
  });
});

it.each([
  ['agent.model', '/settings/models'],
  ['agent.subagents.default', '/settings/agent-route'],
  ['memory.model', '/settings/agent-memory'],
  ['router.scenarios.default', '/settings/agent-route'],
  ['router.fallback.default.0', '/settings/agent-route'],
  ['router.tokenSaver.judge', '/settings/agent-route'],
  ['router.tokenSaver.tiers.medium.model', '/settings/agent-route'],
  ['router.stats.baselineModel', '/settings/agent-route'],
  ['router.stats.modelPricing.HX API/qwen3.6/27b', '/settings/agent-route'],
])('opens the current owner of %s and retains its exact location', (reference, page) => {
  const tab = getModelReferenceTab(reference)!;
  const url = new URL(getSettingsPathFromTab(tab), 'http://fixture');
  expect(url.pathname).toBe(page);
  expect(url.searchParams.get('reference')).toBe(reference);
});
