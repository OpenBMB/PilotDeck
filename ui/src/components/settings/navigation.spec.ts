import { describe, expect, it } from "vitest";
import { mapInitialTabToMenuKey } from "./navigation";

describe("mapInitialTabToMenuKey", () => {
  it("routes the Office preview deep link to its dedicated page", () => {
    expect(mapInitialTabToMenuKey("config:officePreview")).toBe(
      "officePreview",
    );
  });

  it("routes legacy config sections to their dedicated pages", () => {
    expect(mapInitialTabToMenuKey("config:models")).toBe("modelPool");
    expect(mapInitialTabToMenuKey("config:agents")).toBe("agentModel");
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

  it("defaults appearance and unknown tabs to General", () => {
    expect(mapInitialTabToMenuKey("appearance")).toBe("general");
    expect(mapInitialTabToMenuKey("unknown")).toBe("general");
    expect(mapInitialTabToMenuKey(undefined)).toBe("general");
  });
});
