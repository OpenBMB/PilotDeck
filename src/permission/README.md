# Permissions

Evaluates allow/ask/deny rules and persists the shared permission preference.

Entry points: [index.ts](index.ts), [settings.ts](settings.ts), [PermissionRuntime.ts](decision/PermissionRuntime.ts).

The composer global preference maps skipPermissions to Full Access. Plan mode remains a per-turn override; accepted and queued requests retain their captured mode.

Tests: [tests/permission](../../tests/permission). See the [test guide](../../docs/testing.md) for runner selection.
