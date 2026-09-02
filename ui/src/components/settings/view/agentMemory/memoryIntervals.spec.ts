import { describe, expect, it } from "vitest";
import {
  DEFAULT_DREAM_MINUTES,
  DEFAULT_INDEX_MINUTES,
  DREAM_INTERVAL_UNITS,
  INDEX_INTERVAL_UNITS,
  resolveEnabledMemoryIntervals,
  toDisplayUnit,
  toMinutes,
} from "./memoryIntervals";

describe("memory interval helpers", () => {
  it("preserves zero as the disabled interval", () => {
    expect(toDisplayUnit(0, DEFAULT_INDEX_MINUTES, INDEX_INTERVAL_UNITS)).toEqual({
      value: 0,
      unit: "minutes",
    });
    expect(toDisplayUnit(0, DEFAULT_DREAM_MINUTES, DREAM_INTERVAL_UNITS)).toEqual({
      value: 0,
      unit: "hours",
    });
    expect(toMinutes(0, "minutes")).toBe(0);
    expect(toMinutes(0, "hours")).toBe(0);
    expect(toMinutes(0, "days")).toBe(0);
    expect(toMinutes(0, "weeks")).toBe(0);
  });

  it("picks the largest matching unit for each interval kind", () => {
    expect(toDisplayUnit(30, DEFAULT_INDEX_MINUTES, INDEX_INTERVAL_UNITS)).toEqual({
      value: 30,
      unit: "minutes",
    });
    expect(toDisplayUnit(1440, DEFAULT_INDEX_MINUTES, INDEX_INTERVAL_UNITS)).toEqual({
      value: 1,
      unit: "days",
    });
    expect(toDisplayUnit(60, DEFAULT_DREAM_MINUTES, DREAM_INTERVAL_UNITS)).toEqual({
      value: 1,
      unit: "hours",
    });
    expect(toDisplayUnit(10_080, DEFAULT_DREAM_MINUTES, DREAM_INTERVAL_UNITS)).toEqual({
      value: 1,
      unit: "weeks",
    });
  });

  it("converts larger units back to minutes", () => {
    expect(toMinutes(2, "days")).toBe(2880);
    expect(toMinutes(1, "weeks")).toBe(10_080);
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
