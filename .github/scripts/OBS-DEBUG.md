# Isolated OBS sync diagnosis

## Credential configuration

The debug workflow uses credentials scoped to PilotDeck/. Isolation is enforced
by fixed PilotDeck/_debug/<tag>/<run-id>/ paths. Configure the dedicated debug
Environment before enabling live diagnostics; local .env files are not inputs.

The debug workflow is separate from production synchronization. Only pushes to
`codex/obs-sync-debug` start the debug workflow; there is no schedule or dispatch.
The tests job is credential-free. Until repository variable `OBS_DEBUG_ENABLED`
is `true`, it explicitly reports that live acceptance has NOT run and skips it.

The `obs-release-debug` Environment allows only branch `codex/obs-sync-debug`,
has no required reviewer, and disables admin bypass.
Put the debug broker token in Environment Secret `OBS_DEBUG_BEARER_TOKEN`
and route in Environment Variable `OBS_DEBUG_ROUTE`. No short-lived credentials
are saved as secrets. Set repository variable `OBS_DEBUG_ENABLED=true` only after
both exist; push the branch to start a live run. Production Environment
and secrets remain unchanged.

## Diagnostic behavior

The tests job freezes the current latest formal release JSON as an artifact. The
live job downloads that pinned release and validates local files before requesting
credentials. Returned credential scope must exactly match `PilotDeck/`.

The first diagnostic uses serial readback, a five-minute per-object limit and a
shared fifteen-minute OBS budget (also bounded by credential expiry minus two
minutes). Each operation logs start/end, file name, byte count and elapsed time;
every thirty seconds it emits a heartbeat. Raw AWS stderr and credentials are not
logged; failures report only a category and allowlisted AWS error-code format.

A small debug upload/readback precedes the full sync. Artifacts are written to
`PilotDeck/_debug/<tag>/<run-id>/`. The same path is synced twice in one run to
exercise idempotence; smoke objects and the isolated latest.json are excluded
from the exact release-object listing check. Every release object is read back
and hashed before publishing the isolated latest.json, which is also read back.
No delete option is used. Diagnostic logs are retained as artifacts for seven days.

## Readback and validation

Readback uses a seekable temporary file, then checks size and full SHA-256.
Streaming a large AWS CLI download to stdout can exhaust its in-memory chunk
slots. The real-CLI large-object regression covers this dependency boundary;
credential-free tests skip only the integration that needs the installed CLI.

Live acceptance requires full content checks and a same-path repeat. A green
workflow with live diagnostics skipped is not production acceptance. Production
synchronization remains a separate main-only workflow.

```sh
python3 -m unittest discover -s .github/scripts -p 'test_obs_sync_debug.py'
actionlint .github/workflows/obs-sync-debug.yml
```
