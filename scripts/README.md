# Repository tools

Maintained build, development and diagnostic commands. Run from the repository root; application and test entry points are defined in package manifests.

| Tool | Use |
| --- | --- |
| [dev-launcher.mjs](dev-launcher.mjs) | Coordinates local development processes |
| [prepare-computer-use.mjs](prepare-computer-use.mjs) | Prepares checksum-pinned native Driver resources |
| [install-asr.mjs](install-asr.mjs) | Installs or checks the local transcription runtime |
| [benchmark-startup.mjs](benchmark-startup.mjs) | Reproducible startup and fault-injection checks with isolated profiles |
| [benchmark-session-list.mjs](benchmark-session-list.mjs) | Synthetic session-list benchmark |
| [audit-ui-reachability.mjs](audit-ui-reachability.mjs) | Read-only UI import/export report; run with --exports for the second pass |
| [check-ui-build-graph.mjs](check-ui-build-graph.mjs) | Verifies deferred editor/PDF loading from the production Vite manifest and reports startup JavaScript bytes |
| [smoke-llm-center-protocols.mjs](smoke-llm-center-protocols.mjs) | Explicitly enabled live checks for Chat Completions, Messages, Responses and Gemini, including output/context limits |
| [update-web.mjs](update-web.mjs) | Managed Web source update flow |

Driver preparation retries transient HTTP and connection/stream failures up to four attempts, with bounded exponential backoff and a five-minute timeout per attempt. Partial archives are removed before retrying. Permanent HTTP failures and checksum mismatches still fail the build; version and SHA-256 pins remain mandatory. Regression coverage lives in `apps/desktop/scripts/computer-use-download.test.mjs`.

The protocol check requires `PILOTDECK_RUN_LIVE_LLM_CENTER=1`, `PILOTDECK_LLM_CENTER_BASE_URL`, `PILOTDECK_LLM_CENTER_API_KEY`, and at least one `PILOTDECK_LLM_CENTER_{OPENAI,ANTHROPIC,RESPONSES,GEMINI}_MODEL`. It uses synthetic prompts and makes billable provider requests. `PILOTDECK_LLM_CENTER_CONTEXT_PROBE_CHARS=0` disables its large-context probe. Supply credentials through the environment and keep output in ignored artifacts.

The import audit is reusable tooling; its output is not a maintained architecture report and is not an automatic deletion list. Keep ad hoc probes, screenshots and logs in ignored artifacts/ or outputs/. Put durable assertions in [tests](../tests/README.md), not temporary scripts. Desktop packaging tools live in [apps/desktop/scripts](../apps/desktop/scripts).

After `pnpm --dir ui build`, run `node scripts/check-ui-build-graph.mjs`. It follows static imports from both `index.html` and the mandatory `src/App.tsx` entry (or its unique bootstrap-imported App facade), counts shared JavaScript files once, and reports raw bytes plus per-file gzip estimates. Editor/PDF dynamic entries must stay outside startup, PDF must stay outside the editor's static imports, and CodeMirror must stay outside startup. `--dist <build-directory>` inspects an alternate build; graph violations produce a JSON report and a nonzero exit code without byte caps. Validate the checker with `node --test tests/scripts/ui-build-graph.test.mjs`.
