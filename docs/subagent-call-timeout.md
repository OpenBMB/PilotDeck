# Per-call subagent timeout

The `agent` tool accepts optional `timeout_ms` to set the execution timeout for
one child. For example, allow a focused investigation up to 30 seconds:

```json
{
  "description": "Inspect failing tests",
  "prompt": "Read the test failures and summarize the likely cause. Do not edit files.",
  "subagent_type": "explore",
  "timeout_ms": 30000
}
```

An explicit value overrides `agent.subagents.timeoutMs` for this call, including
when it is longer. It does not change the saved settings or later calls. When
omitted, the configured default applies (one hour if not configured). Both the
normal and ask-mode tool schemas expose this option.

Use a positive integer from 1 to 2147483647 milliseconds, inclusive. This bound
avoids overflowing a Node.js timer. Invalid values are rejected before starting
a child; direct tool calls receive the same validation as schema-checked calls.

The existing fork timeout and abort signal enforce the deadline. Parent
cancellation still stops the child earlier, and deadline expiry is reported as
a timeout failure, distinct from a user cancellation. Cancellation remains
cooperative: this parameter does not forcibly terminate code that ignores its
abort signal.

Standalone single-shot hosts without the full subagent runtime return an
explicit unsupported-tool error if `timeout_ms` is supplied. They keep their
existing behavior when it is omitted.
