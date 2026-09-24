import assert from "node:assert/strict";
import test from "node:test";

import { computeNextCronRunAt } from "../../src/cron/runtime/CronSchedule.js";

const cases = [
  {
    name: "matches the weekday when both day fields are restricted",
    expression: "0 9 1 * 1",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-08T09:00:00.000Z",
  },
  {
    name: "matches the month day when both day fields are restricted",
    expression: "0 9 1 * 1",
    after: "2026-06-29T09:00:00.000Z",
    expected: "2026-07-01T09:00:00.000Z",
  },
  {
    name: "still requires the month, hour, and minute to match",
    expression: "15 10 1 7 1",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-07-01T10:15:00.000Z",
  },
  {
    name: "normalizes Sunday 7 when matching either day field",
    expression: "0 9 1 * 7",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-07T09:00:00.000Z",
  },
  {
    name: "matches restricted lists and ranges with OR",
    expression: "0 9 1,15 * 1-5",
    after: "2026-07-31T09:00:00.000Z",
    expected: "2026-08-01T09:00:00.000Z",
  },
  {
    name: "keeps a wildcard month day from bypassing the weekday",
    expression: "0 9 * * 1",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-08T09:00:00.000Z",
  },
  {
    name: "keeps a wildcard weekday from bypassing the month day",
    expression: "0 9 1 * *",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-07-01T09:00:00.000Z",
  },
  {
    name: "matches every day when both day fields are wildcards",
    expression: "0 9 * * *",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-02T09:00:00.000Z",
  },
  {
    name: "preserves AND matching for wildcard month-day steps",
    expression: "0 9 */2 * 1",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-15T09:00:00.000Z",
  },
  {
    name: "preserves AND matching for wildcard weekday steps",
    expression: "0 9 1 * */2",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-08-01T09:00:00.000Z",
  },
  {
    name: "does not treat an explicit full weekday range as a wildcard",
    expression: "0 9 1 * 0-6",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-02T09:00:00.000Z",
  },
  {
    name: "does not treat an explicit full month-day range as a wildcard",
    expression: "0 9 1-31 * 1",
    after: "2026-06-02T00:00:00.000Z",
    expected: "2026-06-02T09:00:00.000Z",
  },
  {
    name: "retains the leap-day search for a wildcard weekday",
    expression: "0 9 29 2 *",
    after: "2026-01-30T00:00:00.000Z",
    expected: "2028-02-29T09:00:00.000Z",
  },
  {
    name: "does not use the leap-day shortcut for an explicit full weekday range",
    expression: "0 9 29 2 0-6",
    after: "2026-01-30T00:00:00.000Z",
    expected: "2026-02-01T09:00:00.000Z",
  },
  {
    name: "matches weekdays in February even outside a leap year",
    expression: "0 9 29 2 1",
    after: "2026-01-30T00:00:00.000Z",
    expected: "2026-02-02T09:00:00.000Z",
  },
  {
    name: "matches either day field in the task timezone",
    expression: "0 9 1 * 1",
    after: "2026-06-07T20:00:00.000Z",
    timezone: "Asia/Shanghai",
    expected: "2026-06-08T01:00:00.000Z",
  },
];

for (const { name, expression, after, timezone, expected } of cases) {
  test(`CronSchedule ${name}`, () => {
    assert.equal(
      computeNextCronRunAt(expression, new Date(after), timezone ?? "UTC")?.toISOString(),
      expected,
    );
  });
}
