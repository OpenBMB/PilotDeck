# Agent Notes

Agent Notes record decisions that affect how coding agents and maintainers
must preserve a behavior or architecture contract. They are short decision
records, not replacements for API reference or test files.

Add a note when a change introduces or changes one of these contracts:

- Gateway/session/turn ownership or protocol event pairing.
- Model provider normalization, retry or streaming terminal behavior.
- Router/config reload, allowlist, fallback or persistence semantics.
- File/path safety, permission precedence or tool execution recovery.
- UI state reconciliation, active-run identity or reconnect behavior.

Current notes:

- [Gateway protocol contracts](gateway-protocol-contracts.md)
- [Model protocol contracts](model-protocol-contracts.md)
- [Router and configuration contracts](router-and-config-contracts.md)
- [Session and file safety](session-and-file-safety.md)
- [Tool and permission contracts](tool-and-permission-contracts.md)
- [UI state contracts](ui-state-contracts.md)
- [Test evidence and gates](test-evidence-and-gates.md)

Each note should include:

1. Context and the invariant being protected.
2. The public or internal behavior that must remain stable.
3. The deterministic test and, when applicable, mutation proof that protects it.
4. The related quality gate and known external/deferred coverage.

Keep the note focused and link to the owning source and test files. Do not put
credentials, local paths, generated output or temporary evaluation traces in
an Agent Note.
