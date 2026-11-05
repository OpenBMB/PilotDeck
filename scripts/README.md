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
| [update-web.mjs](update-web.mjs) | Managed Web source update flow |

The import audit is reusable tooling; its output is not a maintained architecture report and is not an automatic deletion list. Keep ad hoc probes, screenshots and logs in ignored artifacts/ or outputs/. Put durable assertions in [tests](../tests/README.md), not temporary scripts. Desktop packaging tools live in [apps/desktop/scripts](../apps/desktop/scripts).
