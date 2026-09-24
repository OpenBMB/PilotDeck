# Cron scheduling and the version 3 upgrade

Recurring schedules use five numeric fields: `minute hour day-of-month month
day-of-week`. Sunday is `0` or `7`. Times are interpreted in the task's timezone.

When neither day field starts with `*`, day-of-month and day-of-week match with
**OR**. When either starts with `*`, including `*/n`, they match with **AND**.
This follows Cronie's matching rule. An explicit full range such as `0-6` or
`1-31` is not a wildcard. Month, hour, and minute must always match.

For example, `0 9 1 * 1` runs at 09:00 on every Monday and on the first of each
month. `0 9 1-7 * 1` runs on days 1–7 and every Monday; it does **not** mean the
first Monday of the month. For that requirement, calculate the intended dates
and create explicit one-time schedules instead of using this expression.

## Compatibility notice

Version 2 incorrectly required both restricted day fields to match. Version 3
applies the corrected OR rule to **existing as well as new recurring tasks**.
There is no legacy AND mode. Existing tasks with two restricted day fields can
therefore run more often after upgrading. Review and replace any such schedules
that relied on the old intersection behavior before upgrading, especially tasks
that perform unattended writes or other external actions.

On the first startup after upgrading from version 2, the scheduler preserves
cached runs for expressions whose day-matching rule is unchanged. For changed
expressions, it chooses the earlier of the cached pending run and the next run
under the OR rule. This preserves overdue runs and runs deferred by the
concurrency limit, even when their deferred execution time is still in the
future. Subsequent runs use the corrected matching rule.

Migration updates the computation version and task revision once. Subsequent
restarts reuse the migrated cache. One-time schedules are unaffected. This
upgrade does not replay every historical occurrence that the old AND rule
missed.
