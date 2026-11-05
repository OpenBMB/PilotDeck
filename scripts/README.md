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
| [smoke-llm-center-protocols.mjs](smoke-llm-center-protocols.mjs) | Explicitly enabled live checks for Chat Completions, Messages, Responses and Gemini, including output/context limits |
| [update-web.mjs](update-web.mjs) | Managed Web source update flow |

The protocol check requires `PILOTDECK_RUN_LIVE_LLM_CENTER=1`, `PILOTDECK_LLM_CENTER_BASE_URL`, `PILOTDECK_LLM_CENTER_API_KEY`, and at least one `PILOTDECK_LLM_CENTER_{OPENAI,ANTHROPIC,RESPONSES,GEMINI}_MODEL`. It uses synthetic prompts and makes billable provider requests. `PILOTDECK_LLM_CENTER_CONTEXT_PROBE_CHARS=0` disables its large-context probe. Supply credentials through the environment and keep output in ignored artifacts.

The import audit is reusable tooling; its output is not a maintained architecture report and is not an automatic deletion list. Keep ad hoc probes, screenshots and logs in ignored artifacts/ or outputs/. Put durable assertions in [tests](../tests/README.md), not temporary scripts. Desktop packaging tools live in [apps/desktop/scripts](../apps/desktop/scripts).
