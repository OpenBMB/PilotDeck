# PilotRoute evaluation

Every real run must use a fresh directory such as `evaluation/results/<run_id>/`; the tools refuse to overwrite summary output. Keep model responses and private prompts out of the call ledger. Public fixture IDs, hashes, validator results, and sanitized error categories are sufficient for reproduction.

## Pilot design

Use `tasks/pilot.json` as a 24-task starter set. `split=dev` is for Gate/confidence calibration; `split=test` is frozen before final comparison. Repeated turns from one `session_id` are one resampling unit.

Primary paired strategies are `pilotdeck-fixed-baseline` and `pilotroute-full` with the same model pool. Supplemental strategies are `fixed-strong` and `fixed-cheap`. Ablations are `no-gate`, `no-cache`, and `no-dynamic-recovery`. The all-tiers-same-model scenario is diagnostic only.

Interleave strategy order within each repeat and isolate cache prefixes by `run_id/strategy/task_id`. Reset writable fixtures before every run. Record provider incidents, task budget, stop rule, tool versions, exact models, price table, and commits in `manifest.json`.

## Offline commands

```powershell
pnpm evaluation:budget -- --tasks=32 --strategies=7 --repeats=3 --main-cost=0.08 --judge-cost=0.002 --recovery-rate=0.15 --recovery-cost=0.04 --scoring-cost=0
pnpm evaluation:summarize -- evaluation/results/<run_id>/calls.jsonl evaluation/results/<run_id>/summary
pnpm evaluation:analyze -- evaluation/results/<run_id>/results.jsonl evaluation/results/<run_id>/calls.jsonl evaluation/results/<run_id>/analysis
```

The default estimate is 32 × 5 × 3 = 480 task-strategy runs: main `$38.40`, Judge `$0.96`, expected recovery `$2.88`, scoring `$0`, total `$42.24`. These are planning assumptions, not measured costs.

## Real-run configuration

For each isolated PilotDeck configuration, set these router stats fields and start the normal CLI/API task driver:

```yaml
router:
  stats:
    enabled: true
    ledgerFilePath: D:/PilotDeck/evaluation/results/<run_id>/calls.jsonl
    runId: <run_id>
    taskId: <task_id>
    strategyVersion: <strategy>
    baselineCommit: cfc4d1779228f91fececc5d6705c14dab5b7ef2f
```

Run the same frozen task driver once per strategy/repeat, changing only the intended policy switches. A paid run has not been executed. Before one is authorized, fill `manifest.template.json`, freeze pricing and exact provider model versions, then archive raw `calls.jsonl`, validator outcomes, `tasks.csv`, and `summary.json` together.

Success is determined by fixture validators (tests, exact structured values, or file hashes). Open-ended tasks require a pre-frozen blind rubric; Judge/scorer costs are reported separately. If zero tasks succeed, cost per success is `null`/undefined. Report paired per-task changes and concrete newly failing task IDs; bootstrap at task/session level, never at turn level.

`results.jsonl` contains one row per task execution: `taskId`, `sessionId`, `strategy`, `repeat`, `success`, and `latencyMs`. The analyzer creates `summary.json`, `summary.csv`, and `cost-success.svg`; it refuses to overwrite an existing analysis directory. Unknown-cost attempts remain visible and are excluded from known-cost arithmetic rather than silently converted to zero.
