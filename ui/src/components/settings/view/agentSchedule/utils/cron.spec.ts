import { describe, expect, it } from "vitest";
import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";
import { isCronConfigEnabled } from "./cron";

describe("isCronConfigEnabled", () => {
  it.each([
    { label: "missing cron section", config: {}, expected: false },
    { label: "cron section without enabled", config: { cron: {} }, expected: true },
    { label: "explicitly enabled cron section", config: { cron: { enabled: true } }, expected: true },
    { label: "explicitly disabled cron section", config: { cron: { enabled: false } }, expected: false },
  ] satisfies Array<{
    label: string;
    config: PilotDeckConfig;
    expected: boolean;
  }>)("treats $label as enabled=$expected", ({ config, expected }) => {
    expect(isCronConfigEnabled(config)).toBe(expected);
  });

  it("creates cron.enabled without changing the source config", () => {
    const config: PilotDeckConfig = {
      agent: { model: "provider/model" },
      customEnv: { EXISTING_VALUE: "preserved" },
    };

    const updated = patch(config, ["cron", "enabled"], true);

    expect(updated).toEqual({
      ...config,
      cron: { enabled: true },
    });
    expect(config).not.toHaveProperty("cron");
  });
});
