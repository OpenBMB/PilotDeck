# Tool And Permission Contracts

## Context

Tools are an execution boundary. Permission and safety decisions happen before
execution, and every accepted invocation must produce one terminal result.

## Invariants

- Invalid input is returned as a structured tool error without executing the
  command or mutating unrelated state.
- Safety denies and explicit permission denies cannot be bypassed by plan,
  bypass, session allow, or adapter-specific shortcuts.
- Each tool call ends exactly once as success, failure, timeout, or
  cancellation, with a matching result event.
- Large results are bounded and persisted through an explicit reference;
  binary/Office content is not treated as arbitrary text.

## Evidence and status

- [permission regressions](../../tests/permission/permission-regressions.spec.ts)
- [bash security](../../tests/tool/bash-permission-security.spec.ts)
- [tool recovery](../../tests/tool/error-recovery.spec.ts)
- [tool result/path tests](../../tests/tool)

Pure permission and result-shaping helpers are candidates for 100% coverage.
The full builtin-tool matrix, cancellation paths, and adapter-to-tool entry
coverage are P5 work. No real shell, user configuration, platform account, or
network is required for deterministic tests.
