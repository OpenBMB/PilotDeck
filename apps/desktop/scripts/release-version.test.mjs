import assert from "node:assert/strict";
import test from "node:test";
import { buildDateVersion, buildReleaseTag, formatReleaseDate, parseRevision } from "./release-version.mjs";

test("builds a stable date version and tag", () => {
  assert.equal(buildDateVersion("2026-09-02"), "2026.902.0");
  assert.equal(buildReleaseTag("2026-09-02"), "desktop-v2026.09.02");
});

test("builds a same-day revision", () => {
  assert.equal(buildDateVersion("2026-09-02", 1), "2026.902.1");
  assert.equal(buildReleaseTag("2026-09-02", 1), "desktop-v2026.09.02-r2");
});

test("formats dates in the requested timezone", () => {
  assert.equal(formatReleaseDate(new Date("2026-09-01T18:00:00Z")), "2026-09-02");
});

test("rejects invalid release metadata", () => {
  assert.throws(() => buildDateVersion("2026-13-02"));
  assert.throws(() => buildDateVersion("2026-02-30"));
  assert.throws(() => parseRevision("-1"));
  assert.throws(() => parseRevision("1x"));
  assert.throws(() => parseRevision("999999999999999999999"));
});
