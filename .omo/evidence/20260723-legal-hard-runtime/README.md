# Legal Hard-Case Runtime QA

Date: 2026-07-23

Branch: `codex/legal-runtime-e2e`

Base under test: `7404ba5cc67ae5689ce5ace07ac8a35ef55b3522`, subsequently merged with `origin/main` at `a3d1f7cf32219fea7a397a3ccaa40756cdcdaaed` before delivery.

## What Was Tested

- Drove the production PilotDeck Gateway in an isolated home and project against one fresh 62-file legal due-diligence workload: 37 DOCX, 16 PDF, 5 XLSX, 3 PNG, and 1 PPTX.
- Loaded legal policy only through a temporary Domain Plugin/Skill. The repository changes are generic Harness and office-runtime behavior; no legal rules or case text are embedded in PilotDeck Core.
- Exercised dynamic `UserPromptSubmit` and per-request model prompt patches throughout extraction, scan classification, topic evidence, reverse coverage, and final-integrity phases.
- Required a concrete Markdown deliverable through the generic artifact contract, then independently checked source coverage, PPTX inspection, eight topic-evidence files, reverse coverage, and a final hash-bound integrity sentinel.
- Replayed the difficult case from a fresh project, followed by one short recovery session after the original session accumulated heavy compaction history.
- Ran backend regression, focused UI regression, production UI build, and all DOCX, Spreadsheet, PDF, and PPTX self-tests.

## What Was Observed

- The fresh primary run completed without a runtime error. It made 40 streamed model requests, applied the dynamic prompt patch to every request, completed 41 tool calls, and emitted the required artifact.
- The state-driven prompt survived repeated compaction and detected the uninspected PPTX. Deterministic OOXML extraction covered all 9 slides and produced non-empty text for every slide.
- The ledger closed all 62 sources with no missing or duplicate paths. Machine-readable sources were inspected; scan-only sources were explicitly classified instead of silently treated as reviewed.
- The first artifact passed the runtime contract but manual review found missing topic-evidence files. A short recovery run created all eight topic files, the reverse-coverage report, and the final integrity sentinel, and updated the opinion.
- The post-recovery independent hard verifier passed. The final opinion is 61,313 bytes with SHA-256 `fb8e30384b89faa0e975db0cf92aa8463b77d04ffe8da88302a9b8d16609b68a`.
- Composite milestones caused unnecessary loops. Restricting each dynamic prompt milestone to one observable action produced reliable forward progress.
- The hard run exposed generic runtime defects around transient provider termination, artifact reminders, zero-byte artifacts, extension watcher noise, Python bytecode generation, and intermittent empty LibreOffice conversion output. The fixes are covered by focused tests and full regressions.

## Why It Is Enough

- The real Gateway run proves that generic lifecycle hooks, dynamic prompt injection, Skills, tool execution, compaction recovery, and artifact contracts cooperate on a heterogeneous workload rather than only in unit tests.
- The independent hard verifier does not trust the model's completion message. It derives pass/fail from files, coverage records, and the final opinion hash.
- The legal workflow remains outside PilotDeck Core, demonstrating the intended architecture boundary: generic mechanism in the Harness, legal judgment and workflow in a Skill/Domain Plugin.
- The office self-tests cover the exact conversion and extraction surfaces used by the hard case; backend and filtered UI regressions cover the surrounding product behavior.

## What Was Omitted

- Private legal text, source filenames, case identifiers, model/provider credentials, raw sessions, generated evidence prose, the opinion body, and raw Judge payloads are excluded from git.
- Seventeen scan-only files were classified as unreadable scans in this text-first run; no claim is made that their image contents were semantically reviewed.
- The external 321-checkpoint Judge result is recorded separately in `judge-status.json`. No checkpoint is claimed as passed unless a complete Judge response is available.
- Full UI test and typecheck have upstream baseline failures documented in `known-ui-baselines.md`; the filtered suite and production build passed.

## Evidence Index

- `hard-run-summary.json`: sanitized production Gateway and dynamic-prompt metrics.
- `hard-quality-gate.json`: content-free independent artifact and coverage checks.
- `regression-summary.json`: backend, UI, office-skill, and build results.
- `known-ui-baselines.md`: failures reproduced from byte-identical `origin/main` files/configuration.
- `judge-status.json`: aggregate external Judge result and claim boundary.
