# Model Protocol Contracts

## Context

Provider adapters translate provider-specific requests and streams into the
canonical model protocol. The agent loop consumes canonical events and should
not depend on provider-specific field names.

## Invariants

- Request builders do not mutate the accepted conversation or tool schemas.
- Canonical messages and tool inputs are deep-cloned before provider-specific
  normalization.
- Every provider stream has one terminal message outcome, including failure,
  cancellation, and an exhausted retry sequence.
- Usage and finish reasons are normalized without inventing values that were
  not present in the provider response.
- OpenAI Chat, OpenAI Responses, Anthropic Messages, and Google Gemini
  differences stay inside their provider adapter boundaries.

## Evidence and status

Current deterministic mappings include malformed message handling, OpenAI
reasoning replay, OpenAI Responses terminal failure, Google schema/abort
regressions, streaming recovery, and usage normalization:

- [model regression tests](../../tests/model)
- [model router regressions](../../tests/regressions/model-router-regressions.spec.ts)
- [streaming recovery](../../tests/router/streaming-recovery.spec.ts)

The P1 target is 100% lines/functions/branches for pure protocol, request,
response, stream parser, and assembler modules. Anthropic cache breakpoint
limits, malformed provider payload matrices, duplicate/out-of-order SSE chunks, and
tool-call repair branches are still roadmap work; real provider behavior stays
in external nightly tests.
