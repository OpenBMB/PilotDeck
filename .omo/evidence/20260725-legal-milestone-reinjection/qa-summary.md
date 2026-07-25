# Legal milestone reinjection QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`

## What was tested

- Active legal coverage `PreModelRequest` hooks reinject the current bounded
  milestone even when its digest is unchanged from the previous request.
- Session-state digest deduplication still avoids redundant writes while no
  longer suppressing request-local model context.
- The initial configuration milestone directs the model to execute the
  initializer before inspecting plugin or validator implementation details.
- Missing task values are represented as pending confirmation instead of
  blocking workspace initialization.
- Existing progress lease, AgentLoop boundary, legal validator, real local
  Gateway, artifact, context, tool, and configuration behavior.

## What was observed

- Focused build and test command completed 41/41 tests successfully.
- Full `npm test` completed 238/238 tests successfully.
- Two consecutive unchanged active `PreModelRequest` calls receive identical
  milestone context and the same opaque convergence metadata.
- Progress lease remains evaluation-only and disabled by default.
- No benchmark case name, rubric checkpoint, or legal semantic rule was added
  to PilotDeck Core. Legal action guidance remains inside the legal plugin and
  skill.

## Why this is enough

The focused test proves the exact request-lifetime regression that caused the
v3 Case 09 false stall. The full suite covers the surrounding generic runtime
and real local Gateway integration. This establishes implementation safety but
does not claim model-level task success; a new isolated campaign must still
show that the real Case 09 trajectory executes the initializer and renews the
lease before the cold-start limit.

## What was omitted

No credentials, tokens, auth headers, environment dumps, or raw private case
content are stored here. Real model trajectory evidence belongs in the new
campaign directory rather than this source repository.
