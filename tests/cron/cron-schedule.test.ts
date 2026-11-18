import assert from "node:assert/strict";
import test from "node:test";

import { computeNextCronRunAt, computeNextRunAt, cronDayFieldsUseOr, previewCronSchedule } from "../../src/cron/runtime/CronSchedule.js";

test("calendar schedules match complete clock times on selected local weekdays", () => {
  const schedule = { type: "calendar", times: ["15:40", "10:15"], weekdays: [1, 3], timezone: "Asia/Shanghai" } as const;
  const after = new Date("2026-06-01T01:00:00.000Z");
  assert.deepEqual(previewCronSchedule({ ...schedule, times: [...schedule.times], weekdays: [...schedule.weekdays] }, after), [
    "2026-06-01T02:15:00.000Z", "2026-06-01T07:40:00.000Z", "2026-06-03T02:15:00.000Z",
  ]);
  for (const input of [
    { times: ["24:00"] }, { times: ["10:15", "10:15"] }, { weekdays: [] }, { weekdays: [7] },
  ]) {
    assert.equal(computeNextRunAt({ type: "calendar", times: ["10:15"], timezone: "UTC", ...input }, after), undefined);
  }
});

test("day intervals advance by 24 elapsed hours across a timezone offset change", () => {
  const anchorAt = "2026-03-07T14:00:00.000Z";
  assert.equal(computeNextRunAt({ type: "interval", everySeconds: 86400, anchorAt }, new Date(anchorAt))?.toISOString(),
    "2026-03-08T14:00:00.000Z");
  assert.equal(computeNextRunAt({ type: "calendar", times: ["09:00"], timezone: "America/New_York" }, new Date(anchorAt))?.toISOString(),
    "2026-03-08T13:00:00.000Z");
});

test("CronSchedule classifies v3 day semantics by syntax rather than expanded ranges", () => {
  for (const expression of ["0 9 1 * 1", "0 9 1 * 0-6", "0 9 1-31 * 1", "0 9 1,* * 1"]) {
    assert.equal(cronDayFieldsUseOr(expression), true, expression);
  }
  for (const expression of ["0 9 * * 1", "0 9 1 * *", "0 9 */2 * 1", "0 9 1 * */2", "0 9 *,1 * 1"]) {
    assert.equal(cronDayFieldsUseOr(expression), false, expression);
  }
});

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
