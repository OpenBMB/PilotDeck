import { describe, expect, it } from "vitest";
import {
  DEFAULT_DREAM_MINUTES,
  DEFAULT_INDEX_MINUTES,
  resolveEnabledMemoryIntervals,
  toDisplayUnit,
  toMinutes,
} from "./memoryIntervals";

describe("memory interval helpers", () => {
  it("preserves zero as the disabled interval", () => {
    expect(toDisplayUnit(0, DEFAULT_INDEX_MINUTES)).toEqual({
      value: 0,
      unit: "minutes",
    });
    expect(toMinutes(0, "minutes")).toBe(0);
    expect(toMinutes(0, "hours")).toBe(0);
  });

  it("does not replace explicit zero values when memory is enabled", () => {
    expect(
      resolveEnabledMemoryIntervals({
        autoIndexIntervalMinutes: 0,
        autoDreamIntervalMinutes: 0,
      }),
    ).toEqual({
      autoIndexIntervalMinutes: 0,
      autoDreamIntervalMinutes: 0,
    });
  });

  it("fills defaults only for missing interval values", () => {
    expect(
      resolveEnabledMemoryIntervals({
        autoIndexIntervalMinutes: 15,
      }),
    ).toEqual({
      autoIndexIntervalMinutes: 15,
      autoDreamIntervalMinutes: DEFAULT_DREAM_MINUTES,
    });
  });
});
