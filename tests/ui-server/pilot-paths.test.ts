import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { sanitizeSessionIdForPath } = require(
  join(process.cwd(), "ui/server/utils/pilotPaths.js"),
) as {
  sanitizeSessionIdForPath: (sessionId: string) => string;
};

test("ui/server sanitizeSessionIdForPath matches platform filename rules", () => {
  const result = sanitizeSessionIdForPath("tui:project=C:\\Users\\foo:default");
  const expected = process.platform === "win32"
    ? "tui-project=C-Users-foo-default"
    : "tui:project=C:-Users-foo:default";

  assert.equal(result, expected);
  assert.ok(!result.includes("\\"));
});

test("ui/server sanitizeSessionIdForPath preserves web colon off Windows", () => {
  const result = sanitizeSessionIdForPath("web:s_abc-123");
  const expected = process.platform === "win32" ? "web-s_abc-123" : "web:s_abc-123";

  assert.equal(result, expected);
});
