# Structured subtask delivery

This implementation develops the delivery workflow from the 面壁智能黑客松全场冠军 project for upstream PilotDeck review. The project attribution is supplied by its contributor; measured results are documented separately and never inferred from the award.

## User contract

- Global `agent.delivery.mode` is `auto` (default) or `off`.
- Auto appends an editable delivery instruction to production subagents. The instruction includes a suggested JSON report, explicitly allows task-specific additions/reorganization, and can be changed or restored in Settings. It is an example, not a mandatory business template.
- The parent can add a per-task `delivery.schema` and opt into `delivery.review`. Missing fields are skipped, including all-empty returns. Skipped is never accepted.
- A few machine-readable conventions provide interoperability: `{ "file": "relative/path" }` identifies a declared local file anywhere in the report; a parent-schema string annotated `x-file: true` does the same. Arbitrary strings are not guessed to be paths. The parent's schema applies to the submitted report, not a compulsory `data` wrapper; extra fields are allowed.
- The framework writes each attempt to an independent delivery JSON. Its authoritative `delivery_file` points to that JSON and is returned to the parent. Text-only results live inside it; image/video/PDF/PPT paths can be listed alongside other artifacts. Child claims cannot override the host path, status or usage.
- L1 checks only present, meaningful values: selected basic structure, declared file existence and supplied code locations. No answer keys, numerical answer thresholds, mandatory field completeness, workspace mutation auditing or implicit network requests.
- L2 is one bounded, tool-free model decision, only when requested by the parent and there is meaningful result content. Input is task + expectations + report + explicitly selected result/code excerpts, never the session transcript. Configured reviewer model is optional; otherwise inherit the main conversation model.
- The verdict is accepted/rejected/inconclusive; runtime failure is error. A malformed or empty Judge verdict never accepts. File existence is not proof of content quality, reading, editing or test execution. Binary artifacts are discoverable and file-checkable; this first reviewer is text-only and cannot attest to their visual content.
- Failed actionable checks may repair in the same child session, at most two repairs / three deliveries by default. Missing fields do not trigger repair. Evidence insufficiency and infrastructure errors return to the parent. Other subtasks are not restarted.
- Keep native observation/Memory integration bounded and metadata-only. Never treat skipped as a learning success.

## Configuration and task input

`agent.delivery` supports `mode`, `prompt`, `maxRepairs` (0..5, default 2), `maxTurns` (1..100, default 20), `reviewerModel` (existing provider/model reference), `reviewTimeoutMs` (1000..180000, default 60000), `maxReviewInputTokens` (256..16384, default 4096), `maxReviewOutputTokens` (64..2048, default 512). Omitted prompt uses the built-in example. Empty prompt is allowed and means no user-editable guidance, while framework protocol explanation remains.

Per-task `delivery` only has `{ schema?: object, review?: boolean }`. Global Off takes precedence and does not activate checks even if a stale caller provides a task contract. Invalid contracts are rejected before model execution in Auto. The limited schema dialect supports type/properties/items/title/description/x-file; no required/const/expected/bounds/compositions. Skipping absent values is explicit, not a claim of full JSON Schema compliance.

`null`, whitespace strings, recursively empty objects and empty arrays are absent content; `0` and `false` are present. Nonempty invalid types fail. Array/object containers do not create successful checks without content. Plain final text is retained as unstructured content; malformed attempted JSON is a protocol failure.

## Minimal modules

Delivery types/default prompt, sparse checks, bounded receipt store and review packet construction are isolated under `src/agent/sub/delivery/`. `SubAgentSession` owns attempts and feedback on its existing loop. A model reviewer consumes a packet via the model runtime once. Agent tool/fork types expose the parent choice. Config/gateway wire the user settings and model inheritance. Settings contains a small editable prompt panel. Parent-visible result and native observation carry independent check/review statuses and delivery paths.

Implement against upstream `cfc4d1779228f91fececc5d6705c14dab5b7ef2f`; do not depend on the unrelated open per-subagent model-selection PR. Preserve permission, cancellation, tools and model routing behavior outside this delivery layer.

## Verification and experiments

Test real temporary files, absent/empty fields, flexible structures, location failures, arbitrary binary extensions, archive failure, model opt-in, same-session repair, bounded/no-transcript requests, prompt save/restore and Off. Run existing targeted and broader regressions before publication.

The four engineering experiments are: (1) output guidance vs baseline, one attempt, (2) L1 feedback vs matched-budget retries/Best-of-N and Self-Consistency only for voteable tasks, (3) per-task and aggregate Judge token/cost ratio, (4) L1 vs L1+L2 quality under the same three-attempt cap. Grade actual artifacts independently of the runtime's verdict and retain every group, failure and usage record. Old hackathon results do not prove this implementation's results.

Only propose the PR as an effectiveness improvement if new evidence supports it. A short actual-use video may accompany the PR; show checks, a local repair, the editable prompt and the result file, with secrets excluded.
