# V24R4 QA Evidence

## What Was Tested

- The focused Legal Coverage suite exercised proposal creation, rejection,
  bounded repair feedback, direct apply rejection, successful apply, and the
  product boundary checks.
- The full repository suite covered the unchanged Core and adapter behavior as
  well as the Legal Plugin integration.
- The real local Gateway integration tests drove the built Gateway and project
  hooks through artifact correction and completion blocking.
- A sanitized replay of the exact rejected Case 09 proposal from V24R3 ran
  against the V24R4 Legal Plugin in a disposable copy.

The reproducible commands are recorded in `commands.txt`.

## What Was Observed

- `focused-tests.tap`: 39 tests passed, 0 failed.
- `full-tests.tap`: 282 tests passed, 0 failed; the build also completed.
- `gateway-tests.tap`: 3 tests passed, 0 failed against the real local Gateway.
- `live-failure-replay.json`: the first diagnostic envelope returned all 10
  independent errors from the live failure: 9 time errors and 1 threshold
  error. The exact threshold contract was present in the repair instruction.
- After adding explicit assertions for malformed-fact prerequisite gating and
  direct-apply fail-fast behavior, the focused suite was rerun at 39/39 and the
  final full suite was rerun at 282/282 on 2026-07-27.

## Why This Is Enough

The focused counterexample proves that one fact can report both an invalid time
contract and an invalid threshold contract in one bounded feedback envelope.
Existing success and direct-apply tests prove that acceptance semantics remain
unchanged. The full suite checks the broader regression surface, and the real
Gateway tests prove that the built plugin remains loadable and enforceable at
the harness boundary. The replay ties the change to the exact failure that
blocked V24R3 instead of relying only on a synthetic fixture.

The remaining uncertainty is model behavior in a fresh Case 09 run. That is a
campaign gate, not a reason to broaden this code change.

## What Was Omitted

- No API key, authorization header, environment dump, or user configuration is
  included.
- The live Case 09 workspace was copied to a disposable temporary directory for
  non-mutating diagnosis. Only the sanitized aggregate result is retained.
- The initial focused-test failure caused by inspecting the JSON envelope as an
  escaped outer string is not retained as passing evidence. The assertion was
  corrected to parse the envelope and the complete focused suite was rerun.
