---
name: conduct-legal-due-diligence
description: Conduct source-grounded legal due diligence with structured source and fact ledgers, required legal matrices, cross-fact issue analysis, verified legal authorities, transaction controls, and fail-closed final-opinion coverage. Use for investment, acquisition, financing, compliance, or transaction legal reviews that require a formal legal opinion or risk report based on a document room.
---

# Conduct Legal Due Diligence

Create the legal analysis; let the bundled validator enforce structure and coverage. Never create or edit `completion-proof.json` manually.

## Start The Workspace

1. Follow the current `<hook_context>` legal coverage milestone as the single next action.
2. If configuration is incomplete, use the injected `initializerCommand` as the next tool call before inspecting plugin or validator source. Preserve its manifest-bound input option exactly; supply required deliverables, jurisdiction, and basis date from the task, using an explicit pending-confirmation value when a required value is absent. The initializer creates a non-empty skeleton for each missing `.md`, `.txt`, `.html`, `.htm`, or `.csv` deliverable and never overwrites an existing target. Check its `deliverableSkeletons` result; create unsupported binary formats with the appropriate artifact tool before continuing.
3. Confirm that every required text deliverable skeleton exists at its configured user path. Only then use the exact injected `reference --name data-contracts` command before writing ledger data and `reference --name issue-rules` before completing matrices or issues. These are bundled plugin resources: use the injected CLI command and never guess a workspace-relative `references/` path.
4. Keep all working state under `.pilotdeck/work/legal-coverage/`; keep user deliverables at the configured paths.
5. If `.pilotdeck/input-manifest.json` exists, initialize `config.inputRoots` from its `originalRoot`. Never initialize from attachments or `derivedRoot`.

## Keep Canonical State Single-Writer

1. The main agent is the only writer for `config.json`, `sources.json`, `facts.json`, `matrices.json`, `issues.json`, `authorities.json`, `coverage.json`, and every final deliverable.
2. When an input room has more than 20 files, inventory paths first, then delegate two to four disjoint source batches before reading full source contents into the main context. For smaller rooms, delegate only when it reduces context pressure.
3. Use no more than four concurrent delegated workers. Give each worker a disjoint source batch or legal topic and an explicit output path under `.pilotdeck/work/legal-coverage/fragments/` (or a task-required evidence path).
4. Each fragment must use the exact injected source-review JSON envelope and list source path/ID, inspection method, locator-grounded atomic facts, evidence class, verification state, conflicts, unresolved items, and proposed materiality. The worker returns only the fragment path and a summary under 1,000 characters. A fragment is not mergeable until the Legal Plugin validates its deterministic path, receipt hash, assigned IDs, and row contract.
5. Delegated workers may inspect sources and write only their assigned evidence fragment. They must not edit canonical ledgers, the completion proof, or a final deliverable.
6. After each worker batch returns, follow the injected `sourceFragmentCommand` to prepare only the bounded validated rows instead of reading a complete fragment or replaying raw source text. The command records a state-bound readiness checkpoint; on the next request, follow the advanced `source-fragment-propose` work item and express your legal judgment in the exact injected proposal format without repeating inspection. Do not edit canonical ledgers manually. When the proposal receipt is valid, execute the injected `sourceMergeApplyCommand` exactly. Do not launch a second extraction wave while completed fragments remain unmerged.
7. Treat every canonical write as a bounded transaction: propose at most the injected source/fact limits and at most 24 KiB of serialized new content from one fragment or one ledger section, whichever limit comes first. The Legal Plugin mechanically projects a valid proposal into `facts.json` and reciprocal `sources.json` links as one state-bound transaction. Never emit or replace an entire large ledger in one tool call.
8. A failed worker is retried only for its missing batch; never restart completed batches.
9. When the source milestone injects delegated `workItems.batches`, treat them as the complete pending-source inventory slice. In the next assistant response, launch one `agent` call per injected batch, all as sibling calls, by passing each batch's `agentInput` object verbatim. Do not run another listing, glob, grep, ledger read, or plugin inspection before those calls.

## Build Evidence Before Conclusions

1. When the source milestone injects `sourceBootstrapCommand`, execute it exactly before manually listing manifest rows or delegating review. It creates only deterministic pending source identities and lineage; workers and the main Agent still own evidence review and legal judgment.
2. Inventory every file under every configured input root in `sources.json`. Use one stable source ID per file and record the lowercase SHA-256 of the exact original bytes. If a source changes, re-inspect it and update every dependent ledger before recording the new hash.
3. When `.pilotdeck/input-manifest.json` exists, bind each source row to an original file listed there. For every reviewed non-text original, copy all of its manifest derivations into `derivedArtifacts` as `{ path, sha256, extractionMethod, extractorVersion }`, inspect those verified derivations, and cite the original source ID in facts. Derived text is inspection evidence, not a replacement source.
4. Inspect every machine-readable source completely, including all spreadsheet sheets and presentation slides. Mark a source `unreadable` only after deterministic extraction or inspection fails; record the unresolved items.
5. Treat every configured input root as read-only. Put OCR text, extraction caches, conversion scripts, bounded coverage patch files, and other derived working files under `.pilotdeck/work/legal-coverage/`, never beside source documents. Runner-provided `derivedRoot` files are also read-only.
6. Use only inspection tools already available in the runtime. Do not install system packages, language packages, plugins, or binaries during a legal task. If available deterministic fallbacks cannot read a file, mark it pending manual verification instead of mutating the host environment.
7. Record atomic facts in `facts.json`. Preserve the subject, predicate, value, unit, date or period, source locator, evidence class, verification state, conflict state, and materiality. Do not merge conflicting statements into one fact.
8. Set `material: true` only when the fact changes a legal conclusion, risk severity, transaction control, or unresolved disclosure. Set `critical: true` only when it may block or materially restructure the transaction. Do not default every extracted fact to material or critical.
9. Link each reviewed source to extracted fact IDs or give a specific `noMaterialFactsReason`.
10. Do not set `config.allowNoMaterialFacts` to true for a responsive diligence room. It exists only for a genuinely non-responsive source set after every file was reviewed.
11. Create the configured deliverable skeleton early and update it incrementally. Do not wait until research is complete to start the formal output.

## Complete Legal Analysis

1. Complete every required matrix in `matrices.json`, or record a fact-grounded not-applicable reason. Link every entry to facts. While a matrix is `pending`, use the injected bounded evidence-index selection, proposal, and apply protocol; never read the full `facts.json` or edit `matrices.json` directly. The selection checkpoint records your legal judgment, and the plugin only validates and applies the one-matrix transaction.
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
7. During the coverage phase, use the injected `next-batch --phase coverage` command to read only the next bounded repair slice. Do not scan or rewrite all canonical ledgers to discover uncovered records.
8. Run the injected validator command with `--write-proof`. Fix the first reported blocking condition, rerun, and stop only when it passes.

## Completion Rule

Completion is permitted only when the validator generated a current `.pilotdeck/work/legal-coverage/completion-proof.json`, the dynamic milestone reports validated state, and every other active domain skill and artifact contract has passed. A missing, manually created, stale, or prematurely generated proof is not completion.

For coverage repair, use `schema`, `next-batch`, and `apply-batch`; do not rewrite
the entire `coverage.json`. Apply only the returned group and identities with
the returned `stateHash`, then validate before requesting another batch.
