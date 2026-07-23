---
name: conduct-legal-due-diligence
description: Conduct source-grounded legal due diligence with structured source and fact ledgers, required legal matrices, cross-fact issue analysis, verified legal authorities, transaction controls, and fail-closed final-opinion coverage. Use for investment, acquisition, financing, compliance, or transaction legal reviews that require a formal legal opinion or risk report based on a document room.
---

# Conduct Legal Due Diligence

Create the legal analysis; let the bundled validator enforce structure and coverage. Never create or edit `completion-proof.json` manually.

## Start The Workspace

1. Follow the current `<hook_context>` legal coverage milestone as the single next action.
2. If configuration is incomplete, run the injected `legal-coverage.mjs init` command with every source root, required deliverable, jurisdiction, and basis date.
3. Read `references/data-contracts.txt` before writing ledger data. Read `references/issue-rules.txt` before completing matrices or issues.
4. Keep all working state under `.pilotdeck/work/legal-coverage/`; keep user deliverables at the configured paths.

## Keep Canonical State Single-Writer

1. The main agent is the only writer for `config.json`, `sources.json`, `facts.json`, `matrices.json`, `issues.json`, `authorities.json`, `coverage.json`, and every final deliverable.
2. When an input room has more than 20 files, inventory paths first, then delegate two to four disjoint source batches before reading full source contents into the main context. For smaller rooms, delegate only when it reduces context pressure.
3. Use no more than four concurrent delegated workers. Give each worker a disjoint source batch or legal topic and an explicit output path under `.pilotdeck/work/legal-coverage/fragments/` (or a task-required evidence path).
4. Each fragment must list source path/ID, inspection method, locator-grounded atomic facts, evidence class, verification state, conflicts, unresolved items, and proposed materiality. The worker returns only the fragment path and a summary under 1,000 characters.
5. Delegated workers may inspect sources and write only their assigned evidence fragment. They must not edit canonical ledgers, the completion proof, or a final deliverable.
6. After workers return, the main agent reads fragments instead of replaying all raw source text and serially merges supported facts into canonical state. A failed worker is retried only for its missing batch; never restart completed batches.

## Build Evidence Before Conclusions

1. Inventory every file under every configured input root in `sources.json`. Use one stable source ID per file.
2. Inspect every machine-readable source completely, including all spreadsheet sheets and presentation slides. Mark a source `unreadable` only after deterministic extraction or inspection fails; record the unresolved items.
3. Record atomic facts in `facts.json`. Preserve the subject, predicate, value, unit, date or period, source locator, evidence class, verification state, conflict state, and materiality. Do not merge conflicting statements into one fact.
4. Set `material: true` only when the fact changes a legal conclusion, risk severity, transaction control, or unresolved disclosure. Set `critical: true` only when it may block or materially restructure the transaction. Do not default every extracted fact to material or critical.
5. Link each reviewed source to extracted fact IDs or give a specific `noMaterialFactsReason`.
6. Do not set `config.allowNoMaterialFacts` to true for a responsive diligence room. It exists only for a genuinely non-responsive source set after every file was reviewed.
7. Create the configured deliverable skeleton early and update it incrementally. Do not wait until research is complete to start the formal output.

## Complete Legal Analysis

1. Complete every required matrix in `matrices.json`, or record a fact-grounded not-applicable reason. Link every entry to facts.
2. Link every material or critical fact into at least one matrix. Never mark all matrices not-applicable merely to obtain a structural pass.
3. Apply the cross-fact rules. Create an issue for every timeline collision, threshold breach, rights or governance conflict, liquidity relationship, employment or IP ownership risk, and unresolved source contradiction.
4. Separate facts, assumptions, analysis, unresolved matters, conclusions, and recommendations. Preserve uncertainty instead of choosing an unsupported version.
5. Translate each material risk into concrete controls such as conditions precedent, remediation, representations, warranties, indemnities, price or structure changes, covenants, or post-closing monitoring.
6. Record every relied-on legal authority in `authorities.json`. Every critical issue requires at least one authority. For verified authorities, retain the name, article, effective version and date, source locator, and supported conclusion. Mark unverifiable citations pending instead of fabricating them.
7. Link every complete `legal-authority` matrix entry to `authorityIds`; do not use `authorityNotRequiredReason` to bypass authority support for a critical issue.

## Bind Final Coverage

1. Finish every configured deliverable before final coverage.
2. Compute each deliverable SHA-256 and record it in `coverage.json`.
3. Map every material or critical fact, every issue, and every used authority to a deliverable section and locator.
4. For text deliverables, copy an exact supporting quote into each coverage row. Each row needs distinct supporting text; do not reuse a generic sentence across facts or issues.
5. A material-fact quote must contain the fact subject and either its predicate, value, or date/period. Add a concise evidence appendix when the main analysis would otherwise become unreadable.
6. Mark unresolved facts, issues, and pending authorities as `unresolved` in coverage. Never hide a conflict or verification gap.
7. Run the injected validator command with `--write-proof`. Fix the first reported blocking condition, rerun, and stop only when it passes.

## Completion Rule

Completion is permitted only when the validator generated a current `.pilotdeck/work/legal-coverage/completion-proof.json`, the dynamic milestone reports validated state, and every other active domain skill and artifact contract has passed. A missing, manually created, stale, or prematurely generated proof is not completion.
