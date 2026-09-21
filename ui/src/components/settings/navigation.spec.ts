import { describe, expect, it } from "vitest";
import {
  getSettingsPath,
  getSettingsPathFromTab,
  mapInitialTabToMenuKey,
  mapSettingsSectionToMenuKey,
} from "./navigation";

describe("mapInitialTabToMenuKey", () => {
  it("routes the Office preview deep link to its dedicated page", () => {
    expect(mapInitialTabToMenuKey("config:officePreview")).toBe(
      "module:office-preview",
    );
  });

  it("routes legacy config sections to their dedicated pages", () => {
    expect(mapInitialTabToMenuKey("config:models")).toBe("module:model-providers");
    expect(mapInitialTabToMenuKey("config:agents")).toBe("module:agent-model");
    expect(mapInitialTabToMenuKey("config:memory")).toBe("module:context-memory");
    expect(mapInitialTabToMenuKey("config:tools")).toBe("module:tools-search");
    expect(mapInitialTabToMenuKey("config:webSearch")).toBe("module:tools-search");
    expect(mapInitialTabToMenuKey("config:router")).toBe("module:agent-route");
    expect(mapInitialTabToMenuKey("config:gateway")).toBe("module:integrations");
    expect(mapInitialTabToMenuKey("config:alwaysOn")).toBe("module:agent-resident");
    expect(mapInitialTabToMenuKey("config:cron")).toBe("module:agent-schedule");
    expect(mapInitialTabToMenuKey("config:customEnv")).toBe("module:system-advanced");
  });

  it("maps legacy top-level settings tabs to the new information architecture", () => {
    expect(mapInitialTabToMenuKey("permissions")).toBe("module:tools-permissions");
    expect(mapInitialTabToMenuKey("mcp")).toBe("mcpServers");
    expect(mapInitialTabToMenuKey("gateway")).toBe("integrations");
    expect(mapInitialTabToMenuKey("config")).toBe("modelPool");
  });

  it("defaults appearance and unknown tabs to General", () => {
    expect(mapInitialTabToMenuKey("appearance")).toBe("general");
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
    expect(getSettingsPathFromTab("appearance")).toBe("/settings");
  });

  it("maps menu keys and legacy tabs onto dedicated settings URLs", () => {
    expect(getSettingsPath("modelPool")).toBe("/settings/models");
    expect(getSettingsPath("agentSearch")).toBe("/settings/agent-search");
    expect(getSettingsPathFromTab("config:tools")).toBe("/settings/module/tools-search");
    expect(getSettingsPathFromTab("permissions")).toBe("/settings/module/tools-permissions");
  });

  it("reads the active menu key back from the URL section", () => {
    expect(mapSettingsSectionToMenuKey(undefined)).toBe("module:host-preferences");
    expect(mapSettingsSectionToMenuKey("models")).toBe("module:model-providers");
    expect(mapSettingsSectionToMenuKey("mcp")).toBe("module:mcp-servers");
    expect(mapSettingsSectionToMenuKey("office")).toBe("module:office-preview");
    expect(mapSettingsSectionToMenuKey("privacy")).toBe("module:tools-permissions");
    expect(mapSettingsSectionToMenuKey("about")).toBe("module:system-updates");
  });
});
