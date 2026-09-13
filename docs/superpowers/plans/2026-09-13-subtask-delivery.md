# Subtask Delivery Implementation Plan

> **For agentic workers:** Use bounded OpenCode tasks with independent spec and code review. The parent owns integration, experiments and acceptance. Follow the test-first cycle for behavior changes.

**Goal:** Deliver editable, flexible subtask receipts with sparse automatic checks and parent-selected, bounded model review, then measure and submit an evidence-backed upstream PR.

**Architecture:** Existing child AgentLoop stays responsible for execution. New delivery modules provide pure/predictable validation, receipt persistence and bounded review packets; runtime orchestration adds same-session repair. Settings and config control Auto/Off, editable example guidance and reviewer inheritance.

**Tech Stack:** TypeScript, Node 22, pnpm, native node:test, React/Vitest, existing PilotDeck model/runtime and memory services.

## Task 0 — Baseline and scope

- [x] Fetch upstream and create `/home/cuizhixing/Projects/PilotDeck-delivery-pr` on `feat/subtask-delivery-review`, based on cfc4d17.
- [x] Record latest user changes in `docs/subtask-delivery/DESIGN.md`; old public showcase remains separate.
- [ ] Install locked dependencies and build baseline. Run `node --test --test-force-exit dist/tests/agent/sub/SubAgentSession.spec.js dist/tests/tool/agent*.js` using discovered test names; record full exit state.

## Task 1 — Delivery contract, sparse checker, receipt store

Files: create `src/agent/sub/delivery/{types,prompt,checks,store,packet}.ts`; test `tests/agent/sub/delivery/{checks,store,packet}.spec.ts`.

- [ ] Define these public types before integration (all optional content remains unknown until checked):

```ts
type DeliveryContract = { schema?: Record<string, unknown>; review?: boolean };
type DeliveryIssue = { path: string; code: string; message: string };
type DeliveryChecks = { status: 'passed' | 'failed' | 'skipped' | 'error'; checked: number; issues: DeliveryIssue[]; reason?: string };
type DeliveryReview = { status: 'accepted' | 'rejected' | 'inconclusive' | 'error' | 'skipped'; summary: string; issues: DeliveryIssue[]; model?: {provider: string; model: string}; usage?: import('../../../model/index.js').CanonicalUsage; durationMs: number };
type DeliveryAttempt = { attempt: number; deliveryFile: string; checks: DeliveryChecks; review?: DeliveryReview };
type DeliveryResult = { status: 'passed' | 'failed' | 'skipped' | 'inconclusive' | 'error'; deliveryFile: string; attempts: DeliveryAttempt[]; repairs: number; producerUsage: import('../../../model/index.js').CanonicalUsage; reviewUsage: import('../../../model/index.js').CanonicalUsage };
```

- [ ] Write real-file tests for empty, missing, 0/false, nested flexible file objects, schema x-file, wrong types, missing path, symlink escape, safe line numbers, binary file extension and no source read claims. Watch failures from missing behavior, then implement exports `checkDelivery`, `validateDeliveryContract`, `hasDeliveryContent`, `parseDelivery`.
- [ ] Write archive tests for separate attempts, authoritative `delivery_file`, raw text, invalid IDs, archive path symlinks and write failure. Implement `saveDelivery` with bounded file sizes, safe per-task directory and atomic writes.
- [ ] Write packet tests for result-only text, bounded excerpts, no input-source content, truncation markers and unsupported binary evidence. Implement `buildReviewPacket` with no model/tool calls. Parent adds custom task schema; child structure is advisory and extensible.
- [ ] Add `DEFAULT_DELIVERY_PROMPT` example and `buildDeliveryPrompt` which keeps the host receipt protocol separate from editable guidance. Run tests and typecheck. Commit only allowed modules/tests.

## Task 2 — Config and editable Settings

Files: `src/pilot/config/{types,loadPilotConfig}.ts`, config validation/change classification as needed; `ui/server/services/{pilotdeckConfig,modelReferences}.js`; `ui/src/components/settings/view/{agentDelivery,modelPool,SettingsContent,SettingsSidebar}` and locale/navigation registration. Tests beside existing config and Settings tests.

- [ ] Test config defaults, explicit Off, prompt save/reset/empty, bounds and reviewer reference validation. Implement exactly the fields in DESIGN.md.
- [ ] Test UI controls use persisted config, editable multiline prompt and reset button, reviewer inherit/custom, accessible labels, and Off disabling dependent controls without deleting saved prompt.
- [ ] Add model reference rename/remove handling for reviewer selection. Test round trips and invalid settings. Commit scoped UI/config changes.

## Task 3 — Runtime integration and model reviewer

Files: `src/agent/runtime/{AgentRuntimeConfig,AgentRuntimeDependencies}.ts`, `src/tool/{builtin/agent,protocol/types}.ts`, `src/agent/loop/AgentLoop.ts`, `src/agent/sub/{SubAgentSession,builtinSubagentTypes}.ts`, `src/agent/sub/delivery/reviewer.ts`, `src/cli/createLocalGateway.ts`.

- [ ] Test Auto/no-contract, Off, parent schema/review propagation, final structured output capture, task-scoped receipt and no extra main-session transcript. Preserve standalone fallback with honest unsupported repair reporting.
- [ ] Use one existing child loop and its final messages for every repair. On actionable failure append precise issues and call the same loop, sharing total turns and the two-repair budget. Re-check/re-save each delivery. Abort, model errors and turn limits never turn into success.
- [ ] Implement one model-runtime call per Judge request, empty tools, role-separated untrusted content, no producer messages. Test configured model vs inherited main model, exact call count, limits/timeouts, invalid verdict, accepted-with-issues conflict and evidence insufficiency. Propagate real usage and unknown usage distinctly.
- [ ] Ensure all-empty delivery never invokes Judge; L1 skipped with meaningful unstructured result can still be reviewed when explicitly requested. Keep parent task completion separate from delivery outcome.
- [ ] Run integration and old fork/tool/loop regressions; adjust only expectations intentionally changed by Auto default, preserving explicit Off compatibility.

## Task 4 — Observation and parent-visible presentation

Files: new delivery memory adapter under `src/context/memory/`, gateway wiring, UI subagent detail surfaces discovered via acceptance event/data flow.

- [ ] Test bounded metadata-only observation, skipped excluded from success, separate producer/reviewer usage, Memory disabled and observer failure not changing verdict.
- [ ] Show receipt path, checked fields/issues, requested/not-requested Judge, actual model, repair attempts and usage through existing tool details. Exclude receipt bodies and sensitive prompts from automatic memory.
- [ ] Verify end-to-end a child result opens without reading a session transcript. Run complete build/web build and relevant broader suites; compare any baseline failures.

## Task 5 — Four experiments

Files: `scripts/subtask-delivery-benchmark.ts`, external raw results in `/home/cuizhixing/Projects/pilotdeck-hackathon/verified-subtasks/delivery-20260913/experiments/`, publishable reproduction docs under `docs/subtask-delivery/`.

- [ ] Fixed task set covering code, numerical/report work, research synthesis, plain text and artifact paths. Producer GLM-5.3-Flash, reviewer GLM-5.3 or Flash as actually available; use existing authorized endpoint/config without writing secrets into repo. Record actual provider/model per call.
- [ ] Arms: Off single; guidance-only single; Auto L1 with up to 2 repairs; independent retries/Best-of-N up to 3 proposals including selection cost; Self-Consistency on voteable subset; Auto L1+Judge up to 2 repairs. Keep runtime verdict separate from independent artifact quality grade.
- [ ] Run all arms; retain failure samples, total/individual token usage and repeated input/cache separately. Report first-pass/final success, review ratios, additional successful tasks and cost. No automatic declaration of superiority.

## Task 6 — Actual use, video, review and PR

- [ ] Run UI with temporary private configuration, verify prompt editing/restore, Auto/Off, result file and one real repair. Capture a short H.264 MP4 with readable actual interactions; no API keys or unrelated windows.
- [ ] Review against every DESIGN.md requirement; independent code review with bounded OpenCode read task; fix actionable findings and rerun affected checks.
- [ ] Update docs with actual implementation, experiment evidence and limits. If results support an upstream improvement, push only feature branch to contributor fork and create PR to OpenBMB/PilotDeck main. Include concise award origin and measured behavior, attach video or link uploaded media; do not imply individual endorsement.
- [ ] Verify PR body/files/base, remote checks state and video accessibility. Report actual completion and outstanding maintainer CI approval separately.
