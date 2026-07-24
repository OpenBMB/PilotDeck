# Awaited network timer QA evidence

## What was tested

- `npm test` built the current branch and ran the complete repository test suite.
- `node --test --test-timeout 60000 dist/tests/network/fetch.spec.js` ran the seven focused retry, timeout, abort, and error-normalization tests.
- `manual-runtime.json` records a direct call to the built `networkFetch` implementation. A synthetic first request returned HTTP 503, the awaited 20 ms retry delay elapsed, and the second request returned 200. A separate never-resolving fetch was aborted by the awaited 20 ms timeout.

## What was observed

- Full suite: 145 tests passed, 0 failed, 0 cancelled, exit code 0. Exact output: `full-suite.txt`.
- Focused suite: 7 tests passed, 0 failed, 0 cancelled, exit code 0. Exact output: `focused-tests.txt`.
- Manual runtime: retry completed after 44 ms with two calls and status 200; timeout completed after 22 ms with `network_timeout`. Exact structured output: `manual-runtime.json`.
- Before the fix, the same full suite consistently cancelled all seven network tests with `cancelledByParent` and `Promise resolution is still pending but the event loop has already resolved`.

## Why it is enough

The focused tests cover the network API contract, the full suite covers repository regressions, and the direct built-runtime exercise proves that both awaited timer paths keep the Node process alive until their promises settle.

## What was omitted

No credentials, request headers, environment dumps, or external network traffic were used. The manual runtime used local synthetic fetch implementations only.
