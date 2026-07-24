# Legal Runtime E2E QA

Date: 2026-07-22

Base: `7404ba5cc67ae5689ce5ace07ac8a35ef55b3522`

## What Was Tested

- Replayed one historical complaint-material organization task through the production `createLocalGateway` surface in an isolated workspace and isolated `PILOT_HOME`.
- Reconstructed 15 OCR/text attachments from the archived accepted input. The archive did not contain the original PDF/XLSX binaries.
- Loaded a temporary legal Domain Plugin with `UserPromptSubmit` dynamic context, one required XLSX artifact contract, a legal review Skill, and a `PreModelRequest` patch.
- Drove the bundled Spreadsheet Skill through scaffold, builder editing, build, inspect, audit, render, and final artifact placement.
- Independently imported the final workbook with Codex `@oai/artifact-tool`, inspected workbook/sheet/table structure, scanned formula errors, rendered every worksheet, and visually reviewed the renders.
- Ran the Spreadsheet Skill self-test and focused AgentLoop/artifact regression tests.
- Ran the complete test suite and isolated a pre-existing `networkFetch` cancellation failure exposed by the gate.

## What Was Observed

- The first bounded rerun loaded the legal Skill, read all 15 inputs once, and called `read_file` immediately after spreadsheet scaffold. It ended at `max_turns` without creating the required workbook. This reproduced a generic Harness defect: a final tool-calling turn could reach the max-turn branch before required artifact validation ran.
- A failing-first regression test returned `max_turns` on the old production path. After the fix, the same scenario returns `tool_error` with the missing artifact path.
- The final rerun completed normally with 17 model requests and 37 successful tool calls. It created the required workbook at the exact contracted path and ran inspect/audit/render before completion.
- Independent workbook inspection found three worksheets and three tables. Used ranges were `A1:I26`, `A1:G18`, and `A1:H26`. Formula-error search matched zero cells.
- Visual review found readable titles, headers, wrapped long text, risk colors, and no overlapping or clipped cells across all three worksheet renders and the eight-page print render.
- Spreadsheet self-test passed create, LibreOffice recalculation, inspect, prefixed-OOXML normalization, clean audit, existing-workbook edit-copy, intentional formula-error detection, CSV/TSV, compatibility preflight, and two-page render.
- The first complete suite run passed 155 tests but cancelled all seven `networkFetch` tests because awaited retry/timeout timers were unreferenced and allowed a short-lived Node process to exit. Removing `unref()` from timers owned by an awaited request changed the focused network result from 0/7 completed to 7/7 passed.
- The final complete suite passed 162/162 with zero failures, cancellations, or skips.

## Why It Is Enough

- The Gateway replay exercises dynamic prompt injection, plugin Skill loading, ToolGuard freshness, artifact contracts, max-turn termination, and spreadsheet delivery together on a real historical legal workload.
- The focused test pins the exact generic max-turn/artifact regression without depending on legal content.
- The Spreadsheet self-test exercises the missing-table-style round trip that previously crashed after LibreOffice recalculation.
- The existing network tests exercise retry success, retry-after bounds, error normalization, request timeout, and parent abort propagation without relying on external network access.
- Independent artifact-tool inspection and visual review do not rely on the PilotDeck agent's own success report.

## What Was Omitted

- Original legal text, model credentials, provider configuration, raw session JSONL, generated builder source, and the resulting legal workbook are intentionally excluded from git.
- Original PDF/XLSX visual fidelity was not tested because the archive contains only OCR/text conversions.
- The temporary legal Domain Plugin used 16,384 output tokens and 20 max turns for the successful run. These are domain workflow/test settings, not PilotDeck Core defaults.
- `context_budget` status remained based on the model catalog's 65,536-token default reservation before the `PreModelRequest` patch. This is conservative status/accounting behavior and is left for a separate lifecycle-budget change because it did not invalidate this delivery.

## Cleanup

- Both Gateway runs were disposed by the driver.
- No server, tmux session, browser context, container, or bound port was left running.
- All temporary inputs, isolated homes, generated workbooks, render outputs, and verifier files were moved from `/tmp` to the macOS Trash with explicit paths. The source archive was retained. No user PilotDeck config or main-worktree file was modified.
